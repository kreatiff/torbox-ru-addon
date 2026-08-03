import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export async function verifyBasicAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    reply.header('WWW-Authenticate', 'Basic realm="TorBox RU Admin"');
    await reply.code(401).send('Unauthorized');
    return;
  }

  try {
    const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf8');
    const parts = credentials.split(':');
    const providedUser = parts[0] || '';
    const providedPass = parts.slice(1).join(':') || '';

    const userMatch = timingSafeEqual(digest(providedUser), digest(config.adminUser));
    const passMatch = timingSafeEqual(digest(providedPass), digest(config.adminPass));

    if (!userMatch || !passMatch) {
      reply.header('WWW-Authenticate', 'Basic realm="TorBox RU Admin"');
      await reply.code(401).send('Unauthorized');
    }
  } catch {
    reply.header('WWW-Authenticate', 'Basic realm="TorBox RU Admin"');
    await reply.code(401).send('Unauthorized');
  }
}
