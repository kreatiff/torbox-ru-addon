import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { hasTestDb, truncateAll } from '../db/testDb.js';
import { pool } from '../../src/db/pool.js';
import { config } from '../../src/config.js';
import { downloadFeedEntry } from '../../src/ingest/downloadFeedEntry.js';
import { upsertFiles } from '../../src/db/repositories/filesRepo.js';
import { rebuildAllMappings } from '../../src/ingest/materialize.js';
import { extractEpisodes } from '../../src/llm/opencodeZen.js';

vi.mock('../../src/llm/opencodeZen.js', () => ({
  extractEpisodes: vi.fn(),
}));

function stubFlareSolverrAndTorBox(magnet: string, torrentId: number, hash: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes(':8191')) {
        return new Response(
          JSON.stringify({ status: 'ok', solution: { response: `<a href="${magnet}">m</a>` } }),
          { status: 200 },
        );
      }
      if (url.includes('createtorrent')) {
        return new Response(
          JSON.stringify({ success: true, data: { torrent_id: torrentId, hash } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
}

describe.skipIf(!hasTestDb)('downloadFeedEntry pre-mapping', () => {
  beforeEach(async () => {
    await truncateAll();
    vi.mocked(extractEpisodes).mockReset().mockResolvedValue(null);
    vi.spyOn(config, 'flaresolverrUrl', 'get').mockReturnValue('http://localhost:8191');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('pre-maps the episode at download time, so a later ingest materialises the mapping with zero LLM calls', async () => {
    const title = await pool.query(`insert into titles (name_ru) values ('Большой куш') returning id`);
    const titleId = title.rows[0].id as string;
    await pool.query(
      `insert into feed_entries (topic_id, title_id, raw_title, url, last_updated) values
       (1, $1, 'Большой куш. Бангкок 2 сезон: 5 выпуск [2026]', 'https://rutracker.org/forum/viewtopic.php?t=1', now())`,
      [titleId],
    );

    stubFlareSolverrAndTorBox('magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12', 555, 'ABCDEF1234567890ABCDEF1234567890ABCDEF12');

    const result = await downloadFeedEntry(1);
    expect(result).toEqual({ ok: true, alreadyDownloaded: false, rawTitle: expect.any(String) });

    // A torrent + rule already exist, entirely from the download action --
    // before any "ingest" has run at all.
    const torrentRow = await pool.query(
      `select hash, torbox_id, raw_name_at_ingest, status from torrents where hash = 'abcdef1234567890abcdef1234567890abcdef12'`,
    );
    expect(torrentRow.rows).toHaveLength(1);
    expect(torrentRow.rows[0]).toMatchObject({ torbox_id: 555, status: 'active' });

    const ruleRow = await pool.query(
      `select season, numbering, start_episode, source from rules where torrent_hash = 'abcdef1234567890abcdef1234567890abcdef12'`,
    );
    expect(ruleRow.rows).toEqual([
      { season: 2, numbering: 'sequential', start_episode: 5, source: 'auto' },
    ]);

    // Simulate the *next* ingest run discovering this torrent's real files
    // (this is exactly what a normal mylist poll + upsertFiles would do --
    // deliberately not calling runIngest() itself here, since that would
    // also exercise the LLM auto-proposal path this test wants to prove is
    // never reached for this torrent).
    await upsertFiles([
      {
        torrentHash: 'abcdef1234567890abcdef1234567890abcdef12',
        torboxFileId: 1,
        rawPath: 'Bolshoy.Kush.Bangkok.S02E05.mp4',
        size: 1_000_000_000,
        isVideo: true,
      },
    ]);
    const summary = await rebuildAllMappings();
    expect(summary.rulesFailed).toBe(0);

    const mapping = await pool.query(
      `select m.season, m.episode, t.name_ru
       from mappings m
       join files f on f.id = m.file_id
       join titles t on t.id = m.title_id
       where f.torrent_hash = 'abcdef1234567890abcdef1234567890abcdef12'`,
    );
    expect(mapping.rows).toEqual([{ season: 2, episode: 5, name_ru: 'Большой куш' }]);

    // The whole point: no LLM call was ever made for this torrent, because
    // it never showed up as "unruled" -- the rule already existed.
    expect(extractEpisodes).not.toHaveBeenCalled();
  });

  it('falls through to normal unruled-torrent handling when the episode cannot be parsed from the title', async () => {
    const title = await pool.query(`insert into titles (name_ru) values ('Show') returning id`);
    await pool.query(
      `insert into feed_entries (topic_id, title_id, raw_title, url, last_updated) values
       (2, $1, 'Show [2026, BDRip]', 'https://rutracker.org/forum/viewtopic.php?t=2', now())`,
      [title.rows[0].id],
    );
    stubFlareSolverrAndTorBox('magnet:?xt=urn:btih:1111111111111111111111111111111111111111', 556, '1111111111111111111111111111111111111111');

    const result = await downloadFeedEntry(2);
    expect(result.ok).toBe(true);

    const rules = await pool.query('select count(*) from rules');
    expect(Number(rules.rows[0].count)).toBe(0);
  });

  it('does not pre-map an entry with no title match', async () => {
    await pool.query(
      `insert into feed_entries (topic_id, title_id, raw_title, url, last_updated) values
       (3, null, 'Something 2 сезон: 5 выпуск', 'https://rutracker.org/forum/viewtopic.php?t=3', now())`,
    );
    stubFlareSolverrAndTorBox('magnet:?xt=urn:btih:2222222222222222222222222222222222222222', 557, '2222222222222222222222222222222222222222');

    const result = await downloadFeedEntry(3);
    expect(result.ok).toBe(true);

    const rules = await pool.query('select count(*) from rules');
    expect(Number(rules.rows[0].count)).toBe(0);
    const torrents = await pool.query('select count(*) from torrents');
    expect(Number(torrents.rows[0].count)).toBe(0);
  });
});
