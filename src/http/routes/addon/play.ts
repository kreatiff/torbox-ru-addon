import type { FastifyInstance } from 'fastify';
import { findByIdsWithTorrent } from '../../../db/repositories/filesRepo.js';
import { insertPlayLog } from '../../../db/repositories/playLogRepo.js';
import { getPlaybackUrl } from '../../../torbox/client.js';
import { logger } from '../../../logger.js';

interface PlayParams {
  fileId: string;
}

export async function playRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: PlayParams }>('/play/:fileId', async (request, reply) => {
    const fileId = Number(request.params.fileId);
    if (!Number.isInteger(fileId) || fileId <= 0) {
      return reply.code(404).send();
    }

    const [file] = await findByIdsWithTorrent([fileId]);
    if (!file || file.torrentTorboxId === null) {
      return reply.code(404).send();
    }

    // LOCKED (§5.5): never construct or return a URL containing
    // TORBOX_API_KEY. getPlaybackUrl already keeps that server-side; this
    // route redirecting through it (rather than handing the client a
    // requestdl URL directly) is the entire reason it exists.
    const playbackUrl = await getPlaybackUrl(file.torrentTorboxId, file.torboxFileId);

    // Audit trail only (§5.5: "reveals which mappings are actually being
    // used and which are quietly wrong") -- must never block the redirect.
    insertPlayLog(fileId, request.headers['user-agent'] ?? null).catch((err: unknown) => {
      logger.error({ err, fileId }, 'failed to write play_log');
    });

    return reply.redirect(playbackUrl, 302);
  });
}
