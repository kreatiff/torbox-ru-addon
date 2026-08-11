import type { FastifyInstance } from 'fastify';
import { verifyWebhookToken } from '../../hooks/verifyWebhookToken.js';
import { logger } from '../../../logger.js';
import { runIngestDeduped } from '../../../ingest/pipeline.js';

/**
 * Inbound webhook from TorBox's own "Custom Webhook" notification
 * integration (TorBox web app: Settings > Integrations > Webhook
 * Notifications). TorBox POSTs a generic envelope --
 * `{event, timestamp, data: {title, message}}` -- for whatever it would
 * otherwise show as an in-app notification (download finished, etc.).
 * There's no structured torrent id/hash in that payload, and the exact
 * event/title vocabulary isn't documented as stable across TorBox API
 * versions, so this handler doesn't try to parse or filter it at all: any
 * POST here just means "something changed in your TorBox library, go
 * check" and triggers the same runIngest() the scheduler
 * (src/ingest/scheduler.ts) and the admin UI's manual trigger use --
 * deduped via runIngestDeduped so a burst of TorBox notifications firing
 * close together (e.g. several downloads finishing at once) coalesces into
 * one run instead of several overlapping ones.
 *
 * The actual "Episode X of Show Y added to the library" Discord
 * notification is NOT sent from here -- it's sent from inside runIngest()
 * itself (notifyDiscordEpisodesProcessed, src/notify/discord.ts) once a
 * proposal is actually auto-committed and materialised, so it fires
 * identically regardless of what triggered the run. This route's only job
 * is to wake ingest up sooner than the next scheduled tick.
 *
 * Token-in-path, same convention as the addon routes
 * (src/http/routes/addon/index.ts): the URL doubles as its own credential,
 * since TorBox can't do an interactive auth flow when it calls us. A
 * lenient catch-all content-type parser is registered (scoped to this
 * route module only) so an unexpected Content-Type from TorBox can't turn
 * into a hard 415/400 before the handler even runs -- the payload's exact
 * shape was never load-bearing here anyway.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });

  app.post(
    '/torbox/:token',
    { onRequest: verifyWebhookToken },
    async (request, reply) => {
      let parsedBody: unknown = request.body;
      if (typeof request.body === 'string' && request.body.length > 0) {
        try {
          parsedBody = JSON.parse(request.body);
        } catch {
          // Not JSON -- fine, nothing here depends on the payload shape.
        }
      }
      logger.info({ body: parsedBody }, 'torbox webhook received; triggering ingest');

      // Ack immediately, run in the background -- same reasoning as
      // POST /api/ingest/run (src/http/routes/api/index.ts): TorBox
      // shouldn't have to wait out a full ingest run just to get a 200.
      reply.code(200).send({ ok: true });
      runIngestDeduped().catch((err) => {
        logger.error({ err }, 'ingest run triggered by torbox webhook failed');
      });
    },
  );
}
