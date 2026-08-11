import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Validates :token against TORBOX_WEBHOOK_TOKEN, constant-time -- same
 * approach as verifyAddonToken. Unlike ADDON_TOKEN, TORBOX_WEBHOOK_TOKEN is
 * optional: this integration is opt-in, and an unset token means the route
 * is disabled -- every request 404s rather than being reachable with an
 * empty-string token. A bad or missing token also 404s (not 401/403): don't
 * confirm to an unauthenticated prober that the route exists.
 */
export async function verifyWebhookToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const expected = config.torboxWebhookToken;
  const provided = (request.params as { token?: string }).token ?? '';
  if (!expected || !timingSafeEqual(digest(provided), digest(expected))) {
    await reply.code(404).send();
  }
}
