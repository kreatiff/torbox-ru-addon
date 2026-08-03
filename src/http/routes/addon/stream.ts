import type { FastifyInstance } from 'fastify';
import { findByImdbId } from '../../../db/repositories/titlesRepo.js';
import { findMappingsForEpisode } from '../../../db/repositories/mappingsRepo.js';
import { findByIdsWithTorrent } from '../../../db/repositories/filesRepo.js';
import { getRuleById } from '../../../db/repositories/rulesRepo.js';
import { buildStreams } from '../../streamMapper.js';

interface StreamParams {
  type: string;
  idJson: string;
}

const JSON_SUFFIX = '.json';

export async function streamRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: StreamParams }>('/stream/:type/:idJson', async (request, reply) => {
    const { type, idJson } = request.params;
    // Only "series" is advertised in the manifest (§2); anything else is
    // out of contract for this addon, not just "no results".
    if (type !== 'series' || !idJson.endsWith(JSON_SUFFIX)) {
      return reply.code(404).send();
    }
    const id = idJson.slice(0, -JSON_SUFFIX.length);

    // id = "tt1234567:3:8" (§5.5). A shape Stremio wouldn't actually send
    // (this addon only ever hands out ids of this shape itself) still gets
    // a clean empty result rather than an error.
    const [imdbId, seasonRaw, episodeRaw, ...rest] = id.split(':');
    const season = Number(seasonRaw);
    const episode = Number(episodeRaw);
    if (!imdbId || rest.length > 0 || !Number.isInteger(season) || !Number.isInteger(episode)) {
      return { streams: [] };
    }

    const title = await findByImdbId(imdbId);
    if (!title) {
      return { streams: [] };
    }

    const mappings = await findMappingsForEpisode(title.id, season, episode);
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
