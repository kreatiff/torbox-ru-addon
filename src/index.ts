import { migrateUp } from './db/migrate.js';
import { pool } from './db/pool.js';
import { logger } from './logger.js';
import { config } from './config.js';
import { build } from './http/server.js';

// Milestone 3 shape: migrate -> start the Fastify addon server -> stay
// running. The ingest scheduler is Milestone 6 scope (see decisions.md);
// until then, `npm run ingest` (src/ingest/runOnce.ts, unchanged) remains
// the only way to trigger a run.
logger.info({ nodeEnv: config.nodeEnv }, 'torbox-ru starting (Milestone 3: addon server)');

const app = await build();

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  try {
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
} catch (err) {
  logger.error({ err }, 'startup failed (migration or server listen)');
  await pool.end();
  process.exitCode = 1;
}
