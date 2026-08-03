import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { verifyBasicAuth } from '../../hooks/verifyBasicAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Resolve the static files path.
  // In production, files are compiled to dist/http/routes/admin/index.js, assets in dist/ui.
  // In tests, files are executed directly from src/http/routes/admin/index.ts, assets might not be built yet.
  const pathsToTry = [
    path.resolve(__dirname, '../../../ui'), // production: dist/ui (3 levels up from dist/http/routes/admin)
    path.resolve(__dirname, '../../../../ui'), // dev source: ui (4 levels up from src/http/routes/admin)
  ];

  let uiBuildPath = pathsToTry[0]!;
  for (const p of pathsToTry) {
    if (fs.existsSync(p)) {
      uiBuildPath = p;
      break;
    }
  }

  // Ensure the directory exists to prevent Fastify static from throwing during startup/tests.
  // Warn loudly if neither candidate path was found — this usually means the Vite build hasn't
  // been run yet or the Dockerfile frontend build stage failed.
  if (!fs.existsSync(uiBuildPath)) {
    app.log.warn(
      { uiBuildPath },
      'Admin UI build directory not found — /admin/* will return 404. Run `npm run build` inside ui/ to generate assets.',
    );
    fs.mkdirSync(uiBuildPath, { recursive: true });
  }

  // Gate administrative interface with HTTP Basic Auth
  app.addHook('onRequest', verifyBasicAuth);

  // Serve static assets. Because this plugin is registered with prefix '/admin',
  // we map the static files prefix to '/' so they resolve under '/admin/<file>'
  app.register(fastifyStatic, {
    root: uiBuildPath,
    prefix: '/',
    decorateReply: false,
  });

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
