import type { FastifyInstance, FastifyReply } from 'fastify';
import { listMappedTitles } from '../../../db/repositories/titlesRepo.js';
import { CATALOG_ID } from './manifest.js';
import {
  toMetaPreview,
  matchesSearch,
  parseCatalogExtra,
  CATALOG_PAGE_SIZE,
} from '../../catalogMapper.js';

const JSON_SUFFIX = '.json';

async function respondWithCatalog(
  reply: FastifyReply,
  type: string,
  catalogId: string,
  extraRaw: string | undefined,
): Promise<unknown> {
  // Out of contract, same posture as stream.ts's non-series 404: only one
  // catalog exists, only for "series".
  if (type !== 'series' || catalogId !== CATALOG_ID) {
    return reply.code(404).send();
  }

  const { search, skip } = parseCatalogExtra(extraRaw);
  const titles = await listMappedTitles();
  const filtered = search ? titles.filter((title) => matchesSearch(title, search)) : titles;
  const page = filtered.slice(skip, skip + CATALOG_PAGE_SIZE);

  // No "public": the URL carries ADDON_TOKEN, so this must stay
  // private/per-client, only short-lived enough to smooth Discover
  // scrolling.
  reply.header('cache-control', 'private, max-age=60');
  return { metas: page.map((title) => toMetaPreview(title)) };
}

/**
 * Serves "My TorBox Library" (issue #20): every title with at least one
 * mapped file, imdb-first ids with a torboxru: fallback (catalogMapper.ts).
 * Stremio requests this two different ways depending on whether `extra` is
 * present -- both are registered here against the same handler, following
 * stream.ts's "strip .json manually" convention:
 *
 *   GET /catalog/series/torbox-ru-library.json
 *   GET /catalog/series/torbox-ru-library/search=foo&skip=100.json
 */
export async function catalogRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { type: string; idJson: string } }>(
    '/catalog/:type/:idJson',
    async (request, reply) => {
      const { type, idJson } = request.params;
      if (!idJson.endsWith(JSON_SUFFIX)) {
        return reply.code(404).send();
      }
      const catalogId = idJson.slice(0, -JSON_SUFFIX.length);
      return respondWithCatalog(reply, type, catalogId, undefined);
    },
  );

  app.get<{ Params: { type: string; catalogId: string; extraJson: string } }>(
    '/catalog/:type/:catalogId/:extraJson',
    async (request, reply) => {
      const { type, catalogId, extraJson } = request.params;
      if (!extraJson.endsWith(JSON_SUFFIX)) {
        return reply.code(404).send();
      }
      const extraRaw = extraJson.slice(0, -JSON_SUFFIX.length);
      return respondWithCatalog(reply, type, catalogId, extraRaw);
    },
  );
}
