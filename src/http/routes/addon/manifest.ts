import type { FastifyInstance } from 'fastify';

// §5.5. types is deliberately ["series"] only, not ["series", "movie"] as
// the spec's literal example shows -- movies are an explicit v1 non-goal
// (§8) and the pipeline is series-first throughout; advertising a type that
// always returns empty is exactly the kind of silent gap the spec elsewhere
// insists on surfacing (confirmed with the repo owner -- see decisions.md).
//
// idPrefixes includes "tmdb:" alongside "tt": found verifying against a
// real account that not every client resolves titles via IMDb -- AIOStreams
// in particular sometimes uses TMDB ids instead. Without "tmdb:" declared
// here, AIOStreams filters this addon out client-side for those titles and
// never even sends the request (see decisions.md); stream.ts's
// parseStreamId handles both id shapes. "torboxru:" is this addon's own
// synthetic id scheme (issue #20, catalogMapper.ts) for a title with no
// imdb_id -- Cinemeta can't render those, so they're browsable/playable
// only via our own catalog/meta/stream routes.
//
// `resources` is kept in short-form array + top-level `idPrefixes`, not the
// per-resource object form, deliberately: the AIOStreams behaviour noted
// above depends on reading *top-level* idPrefixes, and there's no gain here
// from restructuring that risks it.
//
// catalog + meta (issue #20) deliberately reverse spec §8's "don't build
// catalog/meta/synthetic IDs yet" non-goal, at the repo owner's request --
// see docs/decisions.md for the full record. `version` bumps 0.1.0 ->
// 0.2.0 alongside this: Stremio caches a manifest per addon version, so a
// resource change without a bump would leave existing installs stuck on
// the old stream-only manifest until they reinstall anyway (see README).
export const CATALOG_ID = 'torbox-ru-library';

const MANIFEST = {
  id: 'casa.dominus.torbox-ru',
  version: '0.2.0',
  name: 'TorBox RU',
  resources: ['stream', 'catalog', 'meta'],
  types: ['series'],
  idPrefixes: ['tt', 'tmdb:', 'torboxru:'],
  catalogs: [
    {
      type: 'series',
      id: CATALOG_ID,
      name: 'My TorBox Library',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false },
      ],
    },
  ],
} as const;

export async function manifestRoute(app: FastifyInstance): Promise<void> {
  app.get('/manifest.json', async () => MANIFEST);
}
