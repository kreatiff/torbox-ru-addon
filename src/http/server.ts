import Fastify from 'fastify';
import { logger } from '../logger.js';
import { addonRoutes } from './routes/addon/index.js';
import { apiRoutes } from './routes/api/index.js';
import { adminRoutes } from './routes/admin/index.js';

/** Builds a Fastify instance without starting it, so tests can `.inject()`
 * against it directly (§5.5/§5.6 host process). Return type is inferred
 * (not annotated as the generic `FastifyInstance`): passing `loggerInstance`
 * narrows Fastify's own logger generic beyond what that generic type
 * default covers. */
export function build() {
  const app = Fastify({ loggerInstance: logger });
  app.register(addonRoutes);
  app.register(apiRoutes, { prefix: '/api' });
  app.register(adminRoutes, { prefix: '/admin' });
  return app;
}
