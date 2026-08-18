import { migrateUp } from './db/migrate.js';
import { pool } from './db/pool.js';
import { logger } from './logger.js';
import { config } from './config.js';
import { build } from './http/server.js';
import { startIngestScheduler } from './ingest/scheduler.js';

// migrate -> start the Fastify addon server -> start the ingest scheduler
// (INGEST_INTERVAL_MINUTES, default 15; 0 disables it) -> stay running.
// `npm run ingest` (src/ingest/runOnce.ts) and the admin UI's "Trigger
// Ingest Run Now" button remain available as manual/on-demand triggers
// alongside the scheduler, not instead of it.
logger.info({ nodeEnv: config.nodeEnv }, 'torbox-ru starting');

const app = await build();
let scheduler: { stop: () => void } | undefined;

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  try {
    scheduler?.stop();
    await app.close();
  } finally {
    await pool.end();
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await migrateUp();
  await app.listen({ host: '0.0.0.0', port: config.port });
  scheduler = startIngestScheduler();
} catch (err) {
  logger.error({ err }, 'startup failed (migration or server listen)');
  await pool.end();
  process.exitCode = 1;
}
