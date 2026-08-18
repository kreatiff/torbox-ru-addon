import Fastify from 'fastify';
import { ZodError } from 'zod';
import secureSession from '@fastify/secure-session';
import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { registerAuth } from './auth.js';
import { addonRoutes } from './routes/addon/index.js';
import { apiRoutes } from './routes/api/index.js';
import { adminRoutes } from './routes/admin/index.js';
import { webhookRoutes } from './routes/webhooks/index.js';

function deriveSessionKey(secret: string): Buffer {
  // Deterministically derive a 32-byte key from the operator-provided secret
  // so any >=32-byte string works, not just a base64-encoded 32-byte buffer.
  return createHash('sha256').update(secret).digest();
}

/** Builds a Fastify instance without starting it, so tests can `.inject()`
 * against it directly (§5.5/§5.6 host process). Return type is inferred
 * (not annotated as the generic `FastifyInstance`): passing `loggerInstance`
 * narrows Fastify's own logger generic beyond what that generic type
 * default covers. */
export async function build() {
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

  await app.register(secureSession, {
    key: deriveSessionKey(config.sessionSecret),
    cookie: {
      path: '/',
      // Use HTTPS-only cookies when the public URL is https, regardless of
      // NODE_ENV, so local HTTP testing works without flipping NODE_ENV.
      secure: config.publicBase.startsWith('https://'),
      httpOnly: true,
      sameSite: 'lax',
    },
  });
  await app.register(registerAuth);
  await app.register(addonRoutes);
  await app.register(apiRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/admin' });
  await app.register(webhookRoutes, { prefix: '/webhooks' });
  await app.ready();
  return app;
}
