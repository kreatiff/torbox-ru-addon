import { migrateUp } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { runIngest } from './pipeline.js';

await migrateUp();
try {
  await runIngest();
} catch (err) {
  logger.error({ err }, 'ingest run failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
