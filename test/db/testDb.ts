import { pool } from '../../src/db/pool.js';

/**
 * Integration tests need a real Postgres (constraints, upserts, unnest —
 * exactly the fidelity the raw-pg-over-an-ORM decision is betting on). Set
 * TEST_DATABASE_URL to any throwaway/dev Postgres 16 instance with the
 * migrations already applied; tests using this helper skip themselves via
 * `describe.skipIf(!hasTestDb)` when it's unset.
 */
export const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

export async function truncateAll(): Promise<void> {
  await pool.query(
    'truncate table play_log, mappings, feed_entries, provider_seasons, rules, files, titles, torrents restart identity cascade',
  );
}
