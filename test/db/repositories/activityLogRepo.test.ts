import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { hasTestDb, truncateAll } from '../testDb.js';
import { pool } from '../../../src/db/pool.js';
import { logActivity, listRecentActivity } from '../../../src/db/repositories/activityLogRepo.js';

describe.skipIf(!hasTestDb)('activityLogRepo', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('logs and lists entries newest first', async () => {
    await logActivity('torbox', 'Suits — S01E01 processed and added to the library.');
    await logActivity('rutracker', 'Matched "Форс-мажоры 2 сезон" to Форс-мажоры.');

    const entries = await listRecentActivity();
    expect(entries).toHaveLength(2);
    // Second call is newer -- listed first.
    expect(entries[0]?.source).toBe('rutracker');
    expect(entries[0]?.message).toBe('Matched "Форс-мажоры 2 сезон" to Форс-мажоры.');
    expect(entries[1]?.source).toBe('torbox');
    expect(entries[0]?.at).toBeInstanceOf(Date);
  });

  it('clamps limit between 1 and 200', async () => {
    for (let i = 0; i < 5; i++) {
      await logActivity('torbox', `Entry ${i}`);
    }

    expect(await listRecentActivity(0)).toHaveLength(1);
    expect(await listRecentActivity(2)).toHaveLength(2);
    expect(await listRecentActivity(1000)).toHaveLength(5);
  });

  it('returns an empty list when nothing has been logged yet', async () => {
    expect(await listRecentActivity()).toEqual([]);
  });
});
