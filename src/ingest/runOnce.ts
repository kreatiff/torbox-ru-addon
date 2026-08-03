import { migrateUp } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { runIngest } from './pipeline.js';

try {
  await migrateUp();
  await runIngest();
} catch (err) {
  logger.error({ err }, 'startup failed (migration or ingest)');
  process.exitCode = 1;
} finally {
  await pool.end();
}
