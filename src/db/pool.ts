import { Pool, type PoolClient } from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';
import './typeParsers.js';

export const pool = new Pool({ connectionString: config.databaseUrl });

// node-postgres's Pool is an EventEmitter that emits 'error' for problems on
// idle clients (a dropped connection, the DB restarting mid-run). With no
// listener, Node treats an unhandled 'error' event as fatal and crashes the
// whole process -- this is what actually keeps that from happening, not a
// hypothetical: a real ECONNREFUSED at boot surfaced it during verification.
pool.on('error', (err) => {
  logger.error({ err }, 'idle Postgres client error');
});

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
