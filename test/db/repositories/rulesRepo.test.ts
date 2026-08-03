import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { hasTestDb, truncateAll } from '../testDb.js';
import { pool } from '../../../src/db/pool.js';
import { getRuleById, listRules } from '../../../src/db/repositories/rulesRepo.js';

async function insertTitleAndTorrent(): Promise<{ titleId: string; torrentHash: string }> {
  const title = await pool.query(
    `insert into titles (name_ru) values ('Тестовое шоу') returning id`,
  );
  const torrentHash = 'hash-rules-test';
  await pool.query(
    `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
     values ($1, 1, 'Тестовое шоу', now())`,
    [torrentHash],
  );
  return { titleId: title.rows[0].id, torrentHash };
}

describe.skipIf(!hasTestDb)('rulesRepo', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('reads a rule back with exceptions parsed from jsonb', async () => {
    const { titleId, torrentHash } = await insertTitleAndTorrent();
    const inserted = await pool.query(
      `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source, exceptions)
       values ($1, $2, 3, 'sequential', 'natural', 1, 1.0, 'manual', $3::jsonb)
       returning id`,
      [torrentHash, titleId, JSON.stringify({ '5': 'ignore', '6': { season: 3, episode: 99 } })],
    );
    const ruleId = inserted.rows[0].id;

    const rule = await getRuleById(ruleId);
    expect(rule).toBeDefined();
    expect(rule?.torrentHash).toBe(torrentHash);
    expect(rule?.titleId).toBe(titleId);
    expect(rule?.numbering).toBe('sequential');
    expect(rule?.exceptions).toEqual({ '5': 'ignore', '6': { season: 3, episode: 99 } });
  });

  it('returns undefined for a missing rule id', async () => {
    const rule = await getRuleById('00000000-0000-0000-0000-000000000000');
    expect(rule).toBeUndefined();
  });

  it('listRules returns every rule, oldest first', async () => {
    const { titleId, torrentHash } = await insertTitleAndTorrent();
    await pool.query(
      `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source)
       values ($1, $2, 1, 'sequential', 'natural', 1, 1.0, 'manual'),
              ($1, $2, 2, 'manual', 'natural', 1, 1.0, 'manual')`,
      [torrentHash, titleId],
    );
    const rules = await listRules();
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.season)).toEqual([1, 2]);
  });
});
