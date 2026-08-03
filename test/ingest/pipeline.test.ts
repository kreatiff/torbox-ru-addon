import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { hasTestDb, truncateAll } from '../db/testDb.js';
import { pool } from '../../src/db/pool.js';
import { runIngest } from '../../src/ingest/pipeline.js';

interface MockTorrent {
  id: number;
  hash: string;
  name: string;
  size?: number;
  files?: { id: number; name: string; size: number }[];
}

function stubTorboxApi(opts: { mylist: MockTorrent[]; byId?: Record<number, MockTorrent> }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.includes('/refresh/')) {
        return new Response(null, { status: 200 });
      }
      const idMatch = /[?&]id=(\d+)/.exec(url);
      if (idMatch) {
        const id = Number(idMatch[1]);
        const torrent = opts.byId?.[id];
        return new Response(JSON.stringify({ success: true, data: torrent }), { status: 200 });
      }
      if (url.includes('/torrents/mylist')) {
        return new Response(JSON.stringify({ success: true, data: opts.mylist }), { status: 200 });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
}

describe.skipIf(!hasTestDb)('runIngest (Milestone 1 scope)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('upserts torrents and files when files are inline in the mylist response', async () => {
    stubTorboxApi({
      mylist: [
        {
          id: 1,
          hash: 'hash-a',
          name: 'Сокровища императора',
          size: 40_000_000_000,
          files: [
            { id: 10, name: '01 выпуск.mp4', size: 5_000_000_000 },
            { id: 11, name: '02 выпуск.mp4', size: 5_100_000_000 },
          ],
        },
      ],
    });

    const summary = await runIngest();

    expect(summary.torrentsSeen).toBe(1);
    expect(summary.torrentsNew).toBe(1);
    expect(summary.filesUpserted).toBe(2);
    expect(summary.perIdFetches).toBe(0);

    const files = await pool.query(
      'select * from files where torrent_hash = $1 order by torbox_file_id',
      ['hash-a'],
    );
    expect(files.rows).toHaveLength(2);
    expect(files.rows[0].raw_path).toBe('01 выпуск.mp4');
    expect(files.rows[0].is_video).toBe(true);
  });

  it('falls back to a per-id fetch when files is absent, and only for new hashes', async () => {
    stubTorboxApi({
      mylist: [{ id: 2, hash: 'hash-b', name: 'Ставка на любовь', size: 1000 }],
      byId: {
        2: {
          id: 2,
          hash: 'hash-b',
          name: 'Ставка на любовь',
          files: [{ id: 20, name: '01 выпуск.mp4', size: 1_000_000_000 }],
        },
      },
    });

    const first = await runIngest();
    expect(first.perIdFetches).toBe(1);
    expect(first.filesUpserted).toBe(1);

    // Second run: same torrent, still no inline files in mylist, but the
    // hash is now known — must NOT trigger another per-id fetch.
    stubTorboxApi({
      mylist: [{ id: 2, hash: 'hash-b', name: 'Ставка на любовь', size: 1000 }],
    });
    const second = await runIngest();
    expect(second.perIdFetches).toBe(0);
    expect(second.torrentsNew).toBe(0);
  });

  it('marks a torrent gone when absent, then active again when it reappears', async () => {
    stubTorboxApi({ mylist: [{ id: 3, hash: 'hash-c', name: 'Show', files: [] }] });
    await runIngest();

    stubTorboxApi({ mylist: [] });
    const afterDisappear = await runIngest();
    // mylist is empty on this run -> markAbsentGone's guard makes it a no-op,
    // not a mass wipe. See the next assertion below for the real "gone" path.
    expect(afterDisappear.torrentsMarkedGone).toBe(0);

    stubTorboxApi({ mylist: [{ id: 4, hash: 'hash-other', name: 'Different Show', files: [] }] });
    const afterReplaced = await runIngest();
    expect(afterReplaced.torrentsMarkedGone).toBe(1);

    const status = await pool.query('select status from torrents where hash = $1', ['hash-c']);
    expect(status.rows[0].status).toBe('gone');

    stubTorboxApi({ mylist: [{ id: 3, hash: 'hash-c', name: 'Show', files: [] }] });
    await runIngest();
    const reactivated = await pool.query('select status from torrents where hash = $1', ['hash-c']);
    expect(reactivated.rows[0].status).toBe('active');
  });

  it('does not mark anything gone on a suspicious empty mylist response', async () => {
    stubTorboxApi({ mylist: [{ id: 5, hash: 'hash-d', name: 'Show', files: [] }] });
    await runIngest();

    stubTorboxApi({ mylist: [] });
    await runIngest();

    const status = await pool.query('select status from torrents where hash = $1', ['hash-d']);
    expect(status.rows[0].status).toBe('active');
  });

  it('rebuilds mappings for a pre-existing rule on every run', async () => {
    stubTorboxApi({
      mylist: [
        {
          id: 6,
          hash: 'hash-e',
          name: 'Show',
          files: [
            { id: 60, name: '01.mp4', size: 1 },
            { id: 61, name: '02.mp4', size: 1 },
          ],
        },
      ],
    });
    await runIngest();

    const title = await pool.query(`insert into titles (name_ru) values ('Show') returning id`);
    const rule = await pool.query(
      `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source)
       values ('hash-e', $1, 1, 'sequential', 'natural', 1, 1.0, 'manual') returning id`,
      [title.rows[0].id],
    );

    const summary = await runIngest();
    expect(summary.rulesRebuilt).toBe(1);
    expect(summary.rulesFailed).toBe(0);

    const mappings = await pool.query(
      'select season, episode from mappings where rule_id = $1 order by episode',
      [rule.rows[0].id],
    );
    expect(mappings.rows).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
    ]);
  });
});
