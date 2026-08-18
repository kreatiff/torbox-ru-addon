import type { FastifyInstance } from 'fastify';
import { findByImdbId, findByTmdbId, getTitleById } from '../../../db/repositories/titlesRepo.js';
import { findMappingsForEpisode } from '../../../db/repositories/mappingsRepo.js';
import { findByIdsWithTorrent } from '../../../db/repositories/filesRepo.js';
import { getRuleById } from '../../../db/repositories/rulesRepo.js';
import { buildStreams } from '../../streamMapper.js';
import { SYNTHETIC_SCHEME, isValidUuid } from '../../catalogMapper.js';

interface StreamParams {
  type: string;
  idJson: string;
}

const JSON_SUFFIX = '.json';

export type ParsedStreamId =
  | { scheme: 'imdb'; id: string; season: number; episode: number }
  | { scheme: 'tmdb'; id: number; season: number; episode: number }
  | { scheme: 'internal'; id: string; season: number; episode: number };

/**
 * §5.5 gives the id shape as "tt1234567:3:8" (IMDb), but real clients don't
 * only send that -- AIOStreams in particular resolves some titles via TMDB
 * instead ("tmdb:250793:3:8"), found verifying this against a real account.
 * A third shape, "torboxru:<uuid>:3:8", is this addon's own synthetic id
 * (issue #20 -- catalogMapper.ts's stremioIdForTitle) for a title with no
 * imdb_id; it's the id our own `meta` route hands back in `videos[].id`, so
 * this must stay in sync with toMetaDetail there. Anything that isn't one
 * of these three exact shapes gets a clean empty result from the caller,
 * not an error -- this addon only ever hands out ids of these shapes
 * itself, so a third-party client sending something else isn't malicious,
 * just not something we can resolve.
 */
export function parseStreamId(raw: string): ParsedStreamId | null {
  const parts = raw.split(':');
  if (parts.length === 4 && parts[0] === 'tmdb') {
    const id = Number(parts[1]);
    const season = Number(parts[2]);
    const episode = Number(parts[3]);
    if (!Number.isInteger(id) || !Number.isInteger(season) || !Number.isInteger(episode)) {
      return null;
    }
    return { scheme: 'tmdb', id, season, episode };
  }
  if (parts.length === 4 && parts[0] === SYNTHETIC_SCHEME) {
    const [, id, seasonRaw, episodeRaw] = parts;
    const season = Number(seasonRaw);
    const episode = Number(episodeRaw);
    if (!id || !isValidUuid(id) || !Number.isInteger(season) || !Number.isInteger(episode)) {
      return null;
    }
    return { scheme: 'internal', id, season, episode };
  }
  if (parts.length === 3) {
    const [imdbId, seasonRaw, episodeRaw] = parts;
    const season = Number(seasonRaw);
    const episode = Number(episodeRaw);
    if (!imdbId || !Number.isInteger(season) || !Number.isInteger(episode)) {
      return null;
    }
    return { scheme: 'imdb', id: imdbId, season, episode };
  }
  return null;
}

export async function streamRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: StreamParams }>('/stream/:type/:idJson', async (request, reply) => {
    const { type, idJson } = request.params;
    // Only "series" is advertised in the manifest (§2); anything else is
    // out of contract for this addon, not just "no results".
    if (type !== 'series' || !idJson.endsWith(JSON_SUFFIX)) {
      return reply.code(404).send();
    }
    const id = idJson.slice(0, -JSON_SUFFIX.length);

    const parsed = parseStreamId(id);
    if (!parsed) {
      return { streams: [] };
    }

    const title =
      parsed.scheme === 'tmdb'
        ? await findByTmdbId(parsed.id)
        : parsed.scheme === 'internal'
          ? await getTitleById(parsed.id)
          : await findByImdbId(parsed.id);
    if (!title) {
      return { streams: [] };
    }

    const mappings = await findMappingsForEpisode(title.id, parsed.season, parsed.episode);
    if (mappings.length === 0) {
      return { streams: [] };
    }

    const files = await findByIdsWithTorrent(mappings.map((m) => m.fileId));
    const filesById = new Map(files.map((f) => [f.id, f]));

    const uniqueRuleIds = [...new Set(mappings.map((m) => m.ruleId))];
    const rules = await Promise.all(uniqueRuleIds.map((ruleId) => getRuleById(ruleId)));
    const confidenceByRuleId = new Map(
      rules.filter((rule) => rule !== undefined).map((rule) => [rule.id, rule.confidence]),
    );

    return { streams: buildStreams(mappings, filesById, confidenceByRuleId) };
  });
}
