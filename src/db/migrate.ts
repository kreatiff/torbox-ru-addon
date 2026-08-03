import { runner } from 'node-pg-migrate';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Runs pending migrations from ./migrations (resolved relative to cwd, which
 * must be the repo root — the Dockerfile sets WORKDIR accordingly). Safe to
 * call on every boot: node-pg-migrate tracks applied migrations in its own
 * table and no-ops when there's nothing pending.
 */
export async function migrateUp(): Promise<void> {
  const applied = await runner({
    databaseUrl: config.databaseUrl,
    dir: 'migrations',
    migrationsTable: 'pgmigrations',
    direction: 'up',
    logger: {
      info: (msg: string) => logger.info(msg),
      warn: (msg: string) => logger.warn(msg),
      error: (msg: string) => logger.error(msg),
    },
  });
  logger.info({ count: applied.length }, 'migrations up to date');
}
