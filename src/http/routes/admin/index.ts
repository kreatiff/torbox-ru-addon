import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { verifyBasicAuth } from '../../hooks/verifyBasicAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// production: dist/http/routes/admin/index.js -> dist/ui (3 levels up)
const PROD_UI_PATH = path.resolve(__dirname, '../../../ui');
// dev/test: src/http/routes/admin/index.ts -> ui (4 levels up)
const DEV_UI_PATH = path.resolve(__dirname, '../../../../ui');

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const uiBuildPath = fs.existsSync(path.join(DEV_UI_PATH, 'index.html'))
    ? DEV_UI_PATH
    : PROD_UI_PATH;
  const uiBuildExists = fs.existsSync(path.join(uiBuildPath, 'index.html'));

  // No build found is a real, expected state (tests, or a fresh checkout
  // before `npm run build` has run inside ui/) -- warn and degrade to 404
  // for /admin/* rather than throwing, since that shouldn't take down the
  // addon routes this same process also serves. Never create a directory
  // on disk to paper over this -- that would mask a genuinely broken
  // deployment (e.g. the Dockerfile's frontend build stage failing)
  // instead of surfacing it.
  if (!uiBuildExists) {
    app.log.warn(
      { uiBuildPath },
      'Admin UI build not found -- /admin/* will 404 until `npm run build` runs inside ui/ (or the Docker image is rebuilt).',
    );
  }

  // Gate administrative interface with HTTP Basic Auth, regardless of
  // whether the UI build exists -- don't leak "the build is missing" to an
  // unauthenticated prober either.
  app.addHook('onRequest', verifyBasicAuth);

  if (uiBuildExists) {
    // Serve static assets. Because this plugin is registered with prefix '/admin',
    // we map the static files prefix to '/' so they resolve under '/admin/<file>'
    app.register(fastifyStatic, {
      root: uiBuildPath,
      prefix: '/',
      decorateReply: false,
    });
  }

  // Fallback for Single Page App routing:
  // Since fastifyStatic registers wildcards, we set a plugin-scoped not-found handler.
  // Any request under '/admin/*' that doesn't match a static file falls here and gets index.html.
  app.setNotFoundHandler(async (request, reply) => {
    const indexPath = path.join(uiBuildPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      reply.type('text/html');
      return fs.createReadStream(indexPath);
    }
    return reply.code(404).send('Admin UI assets not built. Build the Vite app first.');
  });
}
