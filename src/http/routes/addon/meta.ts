import type { FastifyInstance } from 'fastify';
import {
  findByImdbId,
  findByTmdbId,
  getTitleById,
  setKinopoiskMetadata,
  type Title,
  type KinopoiskMetadataPatch,
} from '../../../db/repositories/titlesRepo.js';
import { listMappedEpisodesForTitle } from '../../../db/repositories/mappingsRepo.js';
import { getProviderSeason } from '../../../db/repositories/providerSeasonsRepo.js';
import { fetchKinopoiskMetadata } from '../../../metadata/kinopoisk.js';
import { logger } from '../../../logger.js';
import { SYNTHETIC_PREFIX, parseSyntheticId, toMetaDetail } from '../../catalogMapper.js';

interface MetaParams {
  type: string;
  idJson: string;
}

const JSON_SUFFIX = '.json';

/**
 * Resolves the three id shapes this addon ever hands out for a series
 * (mirrors stream.ts's parseStreamId dispatch, minus the season/episode
 * suffix meta ids don't carry): `tmdb:<id>`, our own `torboxru:<uuid>`
 * synthetic scheme (issue #20), or a bare `tt…` id -- the permissive
 * default branch, same posture stream.ts's imdb case already takes.
 */
async function resolveTitleForMetaId(id: string): Promise<Title | null> {
  if (id.startsWith('tmdb:')) {
    const tmdbId = Number(id.slice('tmdb:'.length));
    return Number.isInteger(tmdbId) ? findByTmdbId(tmdbId) : null;
  }
  if (id.startsWith(SYNTHETIC_PREFIX)) {
    const uuid = parseSyntheticId(id);
    return uuid ? getTitleById(uuid) : null;
  }
  return findByImdbId(id);
}

/**
 * Opportunistic, once-ever Kinopoisk backfill for one title (issue #28) --
 * only when it has an imdb_id (Kinopoisk's one reliable cross-reference
 * here) and hasn't been checked before. Best-effort: any failure (API
 * outage, rate limit, a genuine kinopoisk_id unique-constraint collision
 * with another title) is logged and swallowed, never turned into a 500 --
 * the rest of the meta response is still valid without the enrichment.
 * Returns the title with fresh fields only when the fetch+persist both
 * actually succeeded; otherwise returns it unchanged so the next request
 * retries rather than wrongly treating this as "checked."
 */
async function withKinopoiskEnrichment(title: Title): Promise<Title> {
  if (!title.imdbId || title.kinopoiskCheckedAt) {
    return title;
  }

  try {
    const kp = await fetchKinopoiskMetadata(title.imdbId);
    const patch: KinopoiskMetadataPatch = {
      kinopoiskId: kp?.kinopoiskId ?? null,
      description: kp?.description ?? null,
      posterUrl: kp?.posterUrl ?? null,
      genres: kp?.genres ?? [],
      cast: kp?.cast ?? [],
    };
    await setKinopoiskMetadata(title.id, patch);
    return {
      ...title,
      kinopoiskId: patch.kinopoiskId,
      kinopoiskDescription: patch.description,
      kinopoiskPosterUrl: patch.posterUrl,
      kinopoiskGenres: patch.genres,
      kinopoiskCast: patch.cast,
      kinopoiskCheckedAt: new Date(),
    };
  } catch (err) {
    logger.warn(
      { err, titleId: title.id, imdbId: title.imdbId },
      'Kinopoisk metadata fetch failed; serving meta without enrichment',
    );
    return title;
  }
}

/**
 * Serves detail + `videos[]` + Kinopoisk-backed description/genres/cast for
 * a title's meta. Answers for **every** series this library maps, not just
 * imdb_id-less ones -- issue #28 deliberately reverses issue #20's original
 * "404 for tt ids so Cinemeta wins" decision, at the repo owner's explicit
 * request: the whole point is real Russian-language metadata in place of
 * Cinemeta's English (or missing) descriptions, so this addon's own answer
 * must win for every title, not just the ones Cinemeta can't reach at all.
 * See docs/decisions.md.
 */
export async function metaRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: MetaParams }>('/meta/:type/:idJson', async (request, reply) => {
    const { type, idJson } = request.params;
    if (type !== 'series' || !idJson.endsWith(JSON_SUFFIX)) {
      return reply.code(404).send();
    }
    const id = idJson.slice(0, -JSON_SUFFIX.length);

    const resolved = await resolveTitleForMetaId(id);
    if (!resolved) {
      return reply.code(404).send();
    }
    const title = await withKinopoiskEnrichment(resolved);

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
