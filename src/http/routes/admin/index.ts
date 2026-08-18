import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// This file lives at the same depth from the repo root whether it's
// running compiled (dist/http/routes/admin/index.js) or directly from
// source via tsx (src/http/routes/admin/index.ts) -- four levels down
// either way -- and ui/vite.config.ts's outDir ("../dist/ui" relative to
// the ui/ project root) always lands the build at <repo-root>/dist/ui
// regardless of which one is running. One path, not a dev/prod pair: an
// earlier version tried to pick between "../../../ui" and "../../../../ui"
// by checking which existed, but the former is always <repo-root>/src/ui
// (never real) and the latter is <repo-root>/ui -- the *source* tree,
// whose checked-in index.html references unbundled /src/main.tsx and was
// never buildable by a browser -- so that check always "succeeded" against
// the wrong directory once ui/ existed at all, even after a real build.
const UI_BUILD_PATH = path.resolve(__dirname, '../../../..', 'dist', 'ui');

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const uiBuildExists = fs.existsSync(path.join(UI_BUILD_PATH, 'index.html'));

  // No build found is a real, expected state (tests, or a fresh checkout
  // before `npm run build` has run inside ui/) -- warn and degrade to 404
  // for /admin/* rather than throwing, since that shouldn't take down the
  // addon routes this same process also serves. Never create a directory
  // on disk to paper over this -- that would mask a genuinely broken
  // deployment (e.g. the Dockerfile's frontend build stage failing)
  // instead of surfacing it.
  if (!uiBuildExists) {
    app.log.warn(
      { uiBuildPath: UI_BUILD_PATH },
      'Admin UI build not found -- /admin/* will 404 until `npm run build` runs inside ui/ (or the Docker image is rebuilt).',
    );
  }

  if (uiBuildExists) {
    // Serve static assets. Because this plugin is registered with prefix '/admin',
    // we map the static files prefix to '/' so they resolve under '/admin/<file>'
    app.register(fastifyStatic, {
      root: UI_BUILD_PATH,
      prefix: '/',
      decorateReply: false,
    });
  }

  // Fallback for Single Page App routing:
  // Since fastifyStatic registers wildcards, we set a plugin-scoped not-found handler.
  // Any request under '/admin/*' that doesn't match a static file falls here and gets index.html.
  app.setNotFoundHandler(async (request, reply) => {
    const indexPath = path.join(UI_BUILD_PATH, 'index.html');
    if (fs.existsSync(indexPath)) {
      reply.type('text/html');
      return fs.createReadStream(indexPath);
    }
    return reply.code(404).send('Admin UI assets not built. Build the Vite app first.');
  });
}
