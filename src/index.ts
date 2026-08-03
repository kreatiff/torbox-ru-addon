import { migrateUp } from './db/migrate.js';
import { pool } from './db/pool.js';
import { logger } from './logger.js';
import { runIngest } from './ingest/pipeline.js';

// Milestone 1 shape: migrate, ingest once, exit — this is the whole "app"
// for now (`docker compose up` should produce real rows in torrents/files).
// From Milestone 3 onward this becomes: migrate -> start the Fastify server
// -> start the ingest scheduler, and stays running. `npm run ingest`
// (src/ingest/runOnce.ts) exercises just the pipeline in isolation and will
// keep doing so once this file's shape changes.

logger.info({ nodeEnv: process.env.NODE_ENV }, 'torbox-ru starting (Milestone 1: ingest only)');

try {
  await migrateUp();
  await runIngest();
} catch (err) {
  logger.error({ err }, 'startup failed (migration or ingest)');
  process.exitCode = 1;
} finally {
  await pool.end();
}
