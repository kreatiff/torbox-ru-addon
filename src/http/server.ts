import Fastify from 'fastify';
import { ZodError } from 'zod';
import { logger } from '../logger.js';
import { addonRoutes } from './routes/addon/index.js';
import { apiRoutes } from './routes/api/index.js';
import { adminRoutes } from './routes/admin/index.js';
import { webhookRoutes } from './routes/webhooks/index.js';

/** Builds a Fastify instance without starting it, so tests can `.inject()`
 * against it directly (§5.5/§5.6 host process). Return type is inferred
 * (not annotated as the generic `FastifyInstance`): passing `loggerInstance`
 * narrows Fastify's own logger generic beyond what that generic type
 * default covers. */
export function build() {
  const app = Fastify({ loggerInstance: logger });

  // Route handlers validate request bodies with `someSchema.parse(...)`
  // rather than Fastify's built-in Ajv validation (see the schemas in
  // routes/api/index.ts) -- without this, a ZodError from a malformed body
  // is an uncaught exception that surfaces as an opaque 500, hiding what's
  // actually wrong with the request from whoever's calling the API.
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid request body', issues: err.issues });
    }
    throw err;
  });

  app.register(addonRoutes);
  app.register(apiRoutes, { prefix: '/api' });
  app.register(adminRoutes, { prefix: '/admin' });
  app.register(webhookRoutes, { prefix: '/webhooks' });
  return app;
}
