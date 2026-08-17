import { config } from '../config.js';
import { logger } from '../logger.js';
import { runIngestDeduped } from './pipeline.js';

/**
 * Automatic ingest scheduler (Milestone 6's last unbuilt piece besides the
 * webhook boundary -- see docs/milestones.md). Runs `runIngestDeduped()`
 * once immediately, then every `INGEST_INTERVAL_MINUTES` thereafter, for as
 * long as the process is up. A plain `setInterval` rather than a
 * cron-expression library: "every N minutes, starting now" is all this
 * needs, and the project already prefers a small hand-rolled implementation
 * over a new dependency where the built-in primitive is enough (see the
 * OpenCode Zen client for the same reasoning).
 *
 * A run that's still in flight when the next tick fires is left to finish
 * on its own; ticks don't overlap into a second concurrent runIngest()
 * because runIngestDeduped() coalesces onto the in-flight run -- the same
 * coalescing that covers the webhook and the admin "run now" button, since
 * ingest isn't designed to be re-entrant (e.g. two runs racing to mark the
 * same torrent gone).
 *
 * INGEST_INTERVAL_MINUTES=0 disables this entirely -- returns a no-op
 * unref'd handle so callers don't need an `if` at the call site.
 */
export function startIngestScheduler(): { stop: () => void } {
  if (config.ingestIntervalMinutes <= 0) {
    logger.info('automatic ingest scheduler disabled (INGEST_INTERVAL_MINUTES=0)');
    return { stop: (): void => undefined };
  }

  const tick = () => {
    runIngestDeduped().catch((err) => {
      logger.error({ err }, 'scheduled ingest run failed');
    });
  };

  logger.info(
    { intervalMinutes: config.ingestIntervalMinutes },
    'starting automatic ingest scheduler',
  );
  tick();
  const handle = setInterval(tick, config.ingestIntervalMinutes * 60_000);
  // Don't hold the process open on this timer alone -- SIGTERM/SIGINT
  // shutdown (src/index.ts) should still work even mid-interval.
  handle.unref();

  return { stop: () => clearInterval(handle) };
}
