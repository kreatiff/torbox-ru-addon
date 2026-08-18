import type { FastifyInstance } from 'fastify';
import { getTitleById } from '../../../db/repositories/titlesRepo.js';
import { listMappedEpisodesForTitle } from '../../../db/repositories/mappingsRepo.js';
import { getProviderSeason } from '../../../db/repositories/providerSeasonsRepo.js';
import { parseSyntheticId, toMetaDetail } from '../../catalogMapper.js';

interface MetaParams {
  type: string;
  idJson: string;
}

const JSON_SUFFIX = '.json';

/**
 * Serves detail + `videos[]` for a title with no `imdb_id` (issue #20) --
 * the only ids this route ever answers for are our own `torboxru:<uuid>`
 * ones (catalogMapper.ts's stremioIdForTitle/parseSyntheticId). A `tt…` id
 * 404s here on purpose, not as an oversight: Stremio then falls through to
 * Cinemeta for those, which knows far more about the title than we do
 * (episode titles, descriptions, thumbnails) -- this route only exists to
 * cover the gap Cinemeta can't.
 */
export async function metaRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: MetaParams }>('/meta/:type/:idJson', async (request, reply) => {
    const { type, idJson } = request.params;
    if (type !== 'series' || !idJson.endsWith(JSON_SUFFIX)) {
      return reply.code(404).send();
    }
    const id = idJson.slice(0, -JSON_SUFFIX.length);

    // Rejects anything not our own torboxru: scheme, including a malformed
    // uuid -- titles.id is a `uuid` column, so an unvalidated id would
    // otherwise reach getTitleById and throw a raw pg 22P02 (500), not a
    // clean 404.
    const titleId = parseSyntheticId(id);
    if (!titleId) {
      return reply.code(404).send();
    }

    const title = await getTitleById(titleId);
    if (!title) {
      return reply.code(404).send();
    }

    const episodes = await listMappedEpisodesForTitle(title.id);

    // Best-effort air dates from the already-cached provider_seasons
    // (src/metadata/tmdb.ts) -- one lookup per distinct mapped season, not
    // per episode. A season with no cached entry just omits `released` for
    // its episodes rather than blocking the response on a live fetch.
    const seasons = [...new Set(episodes.map((e) => e.season))];
    const providerSeasons = await Promise.all(
      seasons.map((season) => getProviderSeason(title.id, season, 'tmdb')),
    );
    const releasedBySeasonEpisode = new Map<string, string | null>();
    for (const providerSeason of providerSeasons) {
      if (!providerSeason) continue;
      for (const ep of providerSeason.episodes) {
        releasedBySeasonEpisode.set(`${providerSeason.season}:${ep.episode}`, ep.air_date ?? null);
      }
    }

    return { meta: toMetaDetail(title, episodes, releasedBySeasonEpisode) };
  });
}
