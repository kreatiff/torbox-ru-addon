import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { hasTestDb, truncateAll } from '../db/testDb.js';
import { pool } from '../../src/db/pool.js';
import { runIngest } from '../../src/ingest/pipeline.js';
import { extractEpisodes } from '../../src/llm/opencodeZen.js';

vi.mock('../../src/llm/opencodeZen.js', () => ({
  extractEpisodes: vi.fn(),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rutrackerFixtureXml = readFileSync(
  path.join(__dirname, '../fixtures/rutracker-f939.xml'),
  'utf-8',
);

interface MockTorrent {
  id: number;
  hash: string;
  name: string;
  size?: number;
  files?: { id: number; name: string; size: number }[];
}

function stubTorboxApi(opts: {
  mylist: MockTorrent[];
  byId?: Record<number, MockTorrent>;
  feedXml?: string;
}) {
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
      if (url.includes('feed.rutracker.cc')) {
        // No opts.feedXml means "feed unreachable in this test" -- fetchFeed
        // swallows this (never throws), so most tests don't need to care.
        if (opts.feedXml === undefined) {
          throw new Error('rutracker feed not stubbed for this test');
        }
        return new Response(opts.feedXml, { status: 200 });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
}

describe.skipIf(!hasTestDb)('runIngest (Milestone 1 scope)', () => {
  beforeEach(async () => {
    await truncateAll();
    // Default: no LLM extraction (as if OPENCODE_ZEN_API_KEY were unset) --
    // unruled torrents simply queue for manual review unless a test opts in
    // with its own mockImplementation/mockResolvedValueOnce below.
    vi.mocked(extractEpisodes).mockReset().mockResolvedValue(null);
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
    // Insert the torrent, files, and rule directly rather than via a first
    // runIngest() call: since Milestone 5, an unruled active torrent gets
    // auto-proposed a rule on its very first ingest, which would collide
    // with the manual rule this test inserts below. Pre-seeding the rule
    // means the torrent is never "unruled" in the first place, keeping this
    // test isolated to what it actually checks -- rebuildAllMappings()
    // against a rule that already existed before ingest ran.
    await pool.query(
      `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
       values ('hash-e', 6, 'Show', now())`,
    );
    await pool.query(
      `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
       values ('hash-e', 60, '01.mp4', 1, true), ('hash-e', 61, '02.mp4', 1, true)`,
    );
    const title = await pool.query(`insert into titles (name_ru) values ('Show') returning id`);
    const rule = await pool.query(
      `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source)
       values ('hash-e', $1, 1, 'sequential', 'natural', 1, 1.0, 'manual') returning id`,
      [title.rows[0].id],
    );

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

  it('auto-proposes and auto-commits a rule for an unruled torrent when the LLM is confident and the title cleanly matches an existing title', async () => {
    await pool.query(`insert into titles (name_ru) values ('Clean Show')`);
    vi.mocked(extractEpisodes).mockImplementation(async (_torrentName, files) => ({
      title: 'Clean Show',
      titleEn: null,
      year: null,
      season: 1,
      files: files.map((f, index) => ({ fileId: f.fileId, episode: index + 1 })),
      confident: true,
      reasoning: 'Files are sequentially numbered with no other episode markers.',
    }));
    stubTorboxApi({
      mylist: [
        {
          id: 7,
          hash: 'hash-f',
          name: 'rutor.info_Clean Show [S01] (2025) WEBRip 1080p от Files-x',
          files: [
            { id: 70, name: '01. Clean Show.mp4', size: 1_000_000_000 },
            { id: 71, name: '02. Clean Show.mp4', size: 1_000_000_000 },
          ],
        },
      ],
    });

    const summary = await runIngest();
    expect(summary.proposalsCreated).toBe(1);
    expect(summary.proposalsAutoCommitted).toBe(1);
    expect(summary.proposalsQueued).toBe(0);

    const mappings = await pool.query(
      `select m.episode from mappings m
       join rules r on r.id = m.rule_id
       where r.torrent_hash = 'hash-f' order by m.episode`,
    );
    expect(mappings.rows).toEqual([{ episode: 1 }, { episode: 2 }]);
  });

  it('does not materialise mappings for an auto-proposed rule when the LLM reports itself not confident, even though the title matches an existing show', async () => {
    // Regression guard: a proposal must never auto-commit on title match
    // alone -- the LLM's own confident:false has to be enough on its own to
    // force a queue, with no mappings materialised.
    await pool.query(`insert into titles (name_ru) values ('Show')`);
    vi.mocked(extractEpisodes).mockImplementation(async (_torrentName, files) => ({
      title: 'Show',
      titleEn: null,
      year: null,
      season: 2,
      files: files.map((f, index) => ({ fileId: f.fileId, episode: index + 1 })),
      confident: false,
      reasoning: 'Declared "5 из 13" but only 6 files are present -- unsure which episodes these are.',
    }));
    stubTorboxApi({
      mylist: [
        {
          id: 8,
          hash: 'hash-g',
          name: 'Show 2 сезон 5 из 13 выпуск',
          files: [1, 2, 3, 4, 5, 6].map((n) => ({
            id: 80 + n,
            name: `Show.s02.E0${n}.mp4`,
            size: 1_000_000_000,
          })),
        },
      ],
    });

    const summary = await runIngest();
    expect(summary.proposalsCreated).toBe(1);
    expect(summary.proposalsAutoCommitted).toBe(0);
    expect(summary.proposalsQueued).toBe(1);

    const rule = await pool.query(
      `select confidence, proposal_reason from rules where torrent_hash = 'hash-g'`,
    );
    expect(rule.rows[0].proposal_reason).toMatch(/unsure which episodes/);

    const mappings = await pool.query(
      `select m.episode from mappings m
       join rules r on r.id = m.rule_id
       where r.torrent_hash = 'hash-g'`,
    );
    expect(mappings.rows).toEqual([]);
  });

  it('regression: resolves a title even when the torrent name has a site-tag prefix and a hard-to-regex "X из Y" phrase order', async () => {
    // Both real torrent names that scored 0% confidence under the old
    // regex cascade: rutor.info_-prefixed, and "range + episode-word + из"
    // ordering that broke both parseXofY and the title-cleaning stripper.
    // The LLM's cleaned title guess plus non-exact-match TMDB/title
    // resolution (pickBestTmdbMatch in pipeline.ts) is what fixes this --
    // this test locks that behaviour in.
    await pool.query(`insert into titles (name_ru) values ('Большой Куш')`);
    vi.mocked(extractEpisodes).mockImplementation(async (_torrentName, files) => ({
      title: 'Большой Куш',
      titleEn: 'Bolshoy Kush',
      year: 2025,
      season: 1,
      files: files.map((f, index) => ({ fileId: f.fileId, episode: index + 1 })),
      confident: true,
      reasoning: 'Twelve sequentially numbered files, no other episode markers.',
    }));
    stubTorboxApi({
      mylist: [
        {
          id: 9,
          hash: 'hash-h',
          name: 'Большой куш. Бангкок 1 сезон 1-12 выпуск из 12 [2025, ТВ-шоу, реалити-шоу, WEBRip]',
          files: [1, 2, 3].map((n) => ({
            id: 90 + n,
            name: `Большой куш. Бангкок.2025.WEB-DLRip.Files-x/0${n}. Большой куш. Бангкок.2025.WEB-DLRip.Files-x.avi`,
            size: 1_000_000_000,
          })),
        },
      ],
    });

    const summary = await runIngest();
    expect(summary.proposalsAutoCommitted).toBe(1);

    const mappings = await pool.query(
      `select m.episode from mappings m
       join rules r on r.id = m.rule_id
       where r.torrent_hash = 'hash-h' order by m.episode`,
    );
    expect(mappings.rows).toEqual([{ episode: 1 }, { episode: 2 }, { episode: 3 }]);
  });

  it('polls the RuTracker feed, matches against the library, and upserts feed_entries', async () => {
    await pool.query(`insert into titles (name_ru) values ('Большой куш')`);
    stubTorboxApi({
      mylist: [{ id: 9, hash: 'hash-h', name: 'Show', files: [] }],
      feedXml: rutrackerFixtureXml,
    });

    const first = await runIngest();
    expect(first.feedEntriesMatched).toBe(5);
    expect(first.feedEntriesNew).toBe(5);

    const rows = await pool.query(
      `select fe.topic_id, t.name_ru
       from feed_entries fe join titles t on t.id = fe.title_id
       order by fe.topic_id`,
    );
    expect(rows.rows).toHaveLength(5);
    expect(rows.rows.every((r) => r.name_ru === 'Большой куш')).toBe(true);

    // Second run against the same feed: still matches the same 5 entries,
    // but none of them are new this time.
    const second = await runIngest();
    expect(second.feedEntriesMatched).toBe(5);
    expect(second.feedEntriesNew).toBe(0);

    const countAfterSecondRun = await pool.query('select count(*) from feed_entries');
    expect(Number(countAfterSecondRun.rows[0].count)).toBe(5);
  });

  it('does not store unmatched feed entries by default', async () => {
    // No titles inserted at all -- every one of the fixture's 50 entries is
    // unmatched.
    stubTorboxApi({
      mylist: [{ id: 10, hash: 'hash-i', name: 'Show', files: [] }],
      feedXml: rutrackerFixtureXml,
    });

    const summary = await runIngest();
    expect(summary.feedEntriesMatched).toBe(0);

    const count = await pool.query('select count(*) from feed_entries');
    expect(Number(count.rows[0].count)).toBe(0);
  });
});
