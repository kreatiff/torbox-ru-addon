import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * LOCKED (§5.5): validate :token against ADDON_TOKEN on every addon route,
 * constant-time. Both sides are hashed to a fixed-length digest first --
 * timingSafeEqual throws on mismatched-length input, and comparing raw
 * strings of different lengths directly would otherwise leak the real
 * token's length. A bad or missing token gets a 404, not 401/403: don't
 * confirm to an unauthenticated prober that the route even exists.
 */
export async function verifyAddonToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const provided = (request.params as { token?: string }).token ?? '';
  if (!timingSafeEqual(digest(provided), digest(config.addonToken))) {
    await reply.code(404).send();
  }
}
