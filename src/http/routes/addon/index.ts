import type { FastifyInstance } from 'fastify';
import { verifyAddonToken } from '../../hooks/verifyAddonToken.js';
import { manifestRoute } from './manifest.js';
import { streamRoute } from './stream.js';
import { playRoute } from './play.js';

// LOCKED (§5.5): config token in the URL path, validated on every route.
// Torrentio convention: /:token/manifest.json, /:token/stream/..., /:token/play/...
export async function addonRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (scope) => {
      scope.addHook('onRequest', verifyAddonToken);
      await scope.register(manifestRoute);
      await scope.register(streamRoute);
      await scope.register(playRoute);
    },
    { prefix: '/:token' },
  );
}
