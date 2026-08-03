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
// parseStreamId handles both id shapes.
const MANIFEST = {
  id: 'casa.dominus.torbox-ru',
  version: '0.1.0',
  name: 'TorBox RU',
  resources: ['stream'],
  types: ['series'],
  idPrefixes: ['tt', 'tmdb:'],
  catalogs: [],
} as const;

export async function manifestRoute(app: FastifyInstance): Promise<void> {
  app.get('/manifest.json', async () => MANIFEST);
}
