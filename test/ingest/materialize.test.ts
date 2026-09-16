import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasTestDb, truncateAll } from '../db/testDb.js';
import { pool } from '../../src/db/pool.js';
import { rebuildAllMappings, type RebuildAllSummary } from '../../src/ingest/materialize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedSql = readFileSync(
  path.join(__dirname, '../../scripts/seed/milestone-2-example.sql'),
  'utf-8',
);

async function mappingsFor(torrentHash: string) {
  const result = await pool.query(
    `select f.raw_path as "rawPath", m.season, m.episode
     from mappings m
     join files f on f.id = m.file_id
     where f.torrent_hash = $1
     order by m.episode`,
    [torrentHash],
  );
  return result.rows;
}

// Exercises the literal Build Order Milestone 2 requirement (spec §6):
// hand-written SQL rules, materialised through the real DB layer end to
// end (not just the pure expandRule function in isolation).
describe.skipIf(!hasTestDb)('Milestone 2: hand-written SQL rules -> mappings', () => {
  let summary: RebuildAllSummary;

  beforeAll(async () => {
    await truncateAll();
    await pool.query(seedSql);
    summary = await rebuildAllMappings();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('processes both hand-written rules with no failures', () => {
    expect(summary.rulesProcessed).toBe(2);
    expect(summary.rulesRewritten).toBe(2);
    expect(summary.rulesFailed).toBe(0);
  });

  it('materialises Сокровища императора season 3 as episodes 1-8, in order', async () => {
    const mappings = await mappingsFor('sokrovishcha-imperatora-s03-milestone2');
    expect(mappings).toEqual(
      Array.from({ length: 8 }, (_, i) => ({
        rawPath: `0${i + 1} выпуск.mp4`,
        season: 3,
        episode: i + 1,
      })),
    );
  });

  it('materialises Ставка на любовь season 2 as episodes 1-10, in natural (not lexical) order', async () => {
    const mappings = await mappingsFor('stavka-na-lyubov-s02-milestone2');
    expect(mappings).toHaveLength(10);
    expect(mappings.map((m: { episode: number }) => m.episode)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    // Natural sort: "10 выпуск.mp4" must land at episode 10, not right after
    // "1"-prefixed names the way a lexical sort would place it.
    expect(mappings[9]).toEqual({ rawPath: '10 выпуск.mp4', season: 2, episode: 10 });
  });

  // Declared last on purpose: these two touch the shared seeded state the
  // assertions above read (the second one deliberately corrupts a row and
  // relies on the reconcile to repair it).
  describe('reconciliation', () => {
    // The reconcile-don't-rewrite property: rebuildAllMappings runs over
    // every rule on every ingest tick, so a steady-state run must check
    // everything and write nothing. Without this test the old
    // delete-plus-reinsert-every-time can come back and nothing fails.
    it('rewrites nothing on a second run when no inputs changed', async () => {
      const before = await pool.query('select xmin, file_id from mappings order by file_id');

      const second = await rebuildAllMappings();
      expect(second.rulesProcessed).toBe(2);
      expect(second.rulesRewritten).toBe(0);
      expect(second.rulesFailed).toBe(0);

      // xmin is the inserting transaction id: unchanged means these are the
      // same physical rows, not identical-looking replacements.
      const after = await pool.query('select xmin, file_id from mappings order by file_id');
      expect(after.rows).toEqual(before.rows);
    });

    it('still repairs a rule whose stored mappings have drifted', async () => {
      await pool.query(
        `update mappings set episode = 99 where file_id = (select min(file_id) from mappings)`,
      );

      const repaired = await rebuildAllMappings();
      expect(repaired.rulesRewritten).toBe(1);
      expect(repaired.rulesFailed).toBe(0);

      const drifted = await pool.query(`select count(*) from mappings where episode = 99`);
      expect(Number(drifted.rows[0].count)).toBe(0);
    });
  });
});
