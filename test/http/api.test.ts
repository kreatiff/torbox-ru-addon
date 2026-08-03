import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { build } from '../../src/http/server.js';
import { config } from '../../src/config.js';
import { searchTitles, fetchExternalIds, fetchSeasonDetails } from '../../src/metadata/tmdb.js';
import { hasTestDb, truncateAll } from '../db/testDb.js';
import { pool } from '../../src/db/pool.js';

vi.mock('../../src/metadata/tmdb.js', () => ({
  searchTitles: vi.fn(),
  fetchExternalIds: vi.fn(),
  fetchSeasonDetails: vi.fn(),
}));

const authHeader = 'Basic ' + Buffer.from('admin:supersecret').toString('base64');

describe('Admin API - Basic Auth', () => {
  beforeEach(() => {
    vi.spyOn(config, 'adminUser', 'get').mockReturnValue('admin');
    vi.spyOn(config, 'adminPass', 'get').mockReturnValue('supersecret');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects requests missing auth header with 401', async () => {
    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/queue',
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Basic realm="TorBox RU Admin"');
    await app.close();
  });

  it('rejects requests with invalid credentials with 401', async () => {
    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/queue',
      headers: {
        authorization: 'Basic ' + Buffer.from('admin:wrongpassword').toString('base64'),
      },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('accepts requests with valid credentials', async () => {
    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/queue',
      headers: {
        authorization: authHeader,
      },
    });
    // It shouldn't be 401 (if no DB, it might skip/pass or return rows depending on hasTestDb, but not 401)
    expect(response.statusCode).not.toBe(401);
    await app.close();
  });

  it('routes search query to TMDB client and returns results', async () => {
    const app = build();
    const mockResults = [
      { tmdbId: 1, nameRu: 'Title', nameEn: 'Title En', year: 2024, posterUrl: null },
    ];
    vi.mocked(searchTitles).mockResolvedValue(mockResults);

    const response = await app.inject({
      method: 'GET',
      url: '/api/titles/search?query=test',
      headers: {
        authorization: authHeader,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(mockResults);
    expect(searchTitles).toHaveBeenCalledWith('test');
    await app.close();
  });
});

describe.skipIf(!hasTestDb)('GET /api/torrents/:hash (real Postgres)', () => {
  beforeEach(async () => {
    vi.spyOn(config, 'adminUser', 'get').mockReturnValue('admin');
    vi.spyOn(config, 'adminPass', 'get').mockReturnValue('supersecret');
    await truncateAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 404 for a hash that was never ingested', async () => {
    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/torrents/does-not-exist',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('returns the torrent and its files, naturally sorted', async () => {
    await pool.query(
      `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
       values ('h1', 1001, 'Show S01', now())`,
    );
    await pool.query(
      `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
       values ('h1', 2, '10.mp4', 200, true), ('h1', 1, '2.mp4', 100, true)`,
    );

    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/torrents/h1',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.hash).toBe('h1');
    expect(body.rawNameAtIngest).toBe('Show S01');
    // Natural sort: "2.mp4" before "10.mp4", not lexicographic ("10" < "2").
    expect(body.files.map((f: { rawPath: string }) => f.rawPath)).toEqual(['2.mp4', '10.mp4']);
    expect(body.rules).toEqual([]);
    await app.close();
  });

  it('includes existing rules with their title joined in, for editing', async () => {
    const title = await pool.query(
      `insert into titles (name_ru, tmdb_id) values ('Show', 42) returning id`,
    );
    const titleId = title.rows[0].id as string;
    await pool.query(
      `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
       values ('h2', 1002, 'Show S02', now())`,
    );
    const rule = await pool.query(
      `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source)
       values ('h2', $1, 2, 'sequential', 'natural', 1, 1.0, 'manual') returning id`,
      [titleId],
    );

    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/torrents/h2',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.rules).toEqual([
      {
        id: rule.rows[0].id,
        season: 2,
        numbering: 'sequential',
        sort: 'natural',
        startEpisode: 1,
        absoluteOffset: null,
        exceptions: {},
        title: {
          id: titleId,
          tmdbId: 42,
          imdbId: null,
          tvdbId: null,
          nameRu: 'Show',
          nameEn: null,
          year: null,
          posterUrl: null,
        },
      },
    ]);
    await app.close();
  });
});

describe.skipIf(!hasTestDb)('POST /api/rules (real Postgres)', () => {
  beforeEach(async () => {
    vi.spyOn(config, 'adminUser', 'get').mockReturnValue('admin');
    vi.spyOn(config, 'adminPass', 'get').mockReturnValue('supersecret');
    await truncateAll();
    await pool.query(
      `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
       values ('h1', 1001, 'Show S01', now())`,
    );
    await pool.query(
      `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
       values ('h1', 1, '01.mp4', 100, true), ('h1', 2, '02.mp4', 100, true)`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects numbering 'parsed' with 400 before creating a rule", async () => {
    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        torrentHash: 'h1',
        season: 1,
        numbering: 'parsed',
        sort: 'natural',
        startEpisode: 1,
        title: { nameRu: 'Show' },
      },
    });
    expect(response.statusCode).toBe(400);
    const rulesCount = await pool.query('select count(*) from rules');
    expect(Number(rulesCount.rows[0].count)).toBe(0);
    await app.close();
  });

  it('creates a title and rule, then rebuilds mappings for the torrent', async () => {
    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        torrentHash: 'h1',
        season: 1,
        numbering: 'sequential',
        sort: 'natural',
        startEpisode: 1,
        title: { nameRu: 'Show' },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);

    const mappings = await pool.query('select season, episode from mappings order by episode');
    expect(mappings.rows).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
    ]);
    await app.close();
  });

  it('reuses an existing titleId instead of creating a new title', async () => {
    const existing = await pool.query(
      `insert into titles (name_ru) values ('Existing Show') returning id`,
    );
    const titleId = existing.rows[0].id as string;

    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        torrentHash: 'h1',
        season: 1,
        numbering: 'sequential',
        sort: 'natural',
        startEpisode: 1,
        titleId,
      },
    });
    expect(response.statusCode).toBe(200);

    const titlesCount = await pool.query('select count(*) from titles');
    expect(Number(titlesCount.rows[0].count)).toBe(1);
    await app.close();
  });

  it('editing a rule with the season unchanged updates the same row in place', async () => {
    const app = build();
    const created = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        torrentHash: 'h1',
        season: 1,
        numbering: 'sequential',
        sort: 'natural',
        startEpisode: 1,
        title: { nameRu: 'Show' },
      },
    });
    const ruleId = created.json().rule.id as string;
    const titleId = created.json().rule.titleId as string;

    const edited = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        ruleId,
        torrentHash: 'h1',
        season: 1,
        numbering: 'manual',
        sort: 'natural',
        startEpisode: 1,
        titleId,
        exceptions: { '1': { season: 1, episode: 5 } },
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().rule.id).toBe(ruleId);

    const rules = await pool.query('select id, numbering from rules');
    expect(rules.rows).toEqual([{ id: ruleId, numbering: 'manual' }]);
    await app.close();
  });

  it('editing a rule into a different season deletes the old rule and its mappings instead of leaving them behind', async () => {
    const app = build();
    const created = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        torrentHash: 'h1',
        season: 1,
        numbering: 'sequential',
        sort: 'natural',
        startEpisode: 1,
        title: { nameRu: 'Show' },
      },
    });
    const ruleId = created.json().rule.id as string;
    const titleId = created.json().rule.titleId as string;
    const originalMappings = await pool.query('select count(*) from mappings');
    expect(Number(originalMappings.rows[0].count)).toBe(2);

    const edited = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        ruleId,
        torrentHash: 'h1',
        season: 2,
        numbering: 'sequential',
        sort: 'natural',
        startEpisode: 1,
        titleId,
      },
    });
    expect(edited.statusCode).toBe(200);
    const newRuleId = edited.json().rule.id as string;
    expect(newRuleId).not.toBe(ruleId);

    // Exactly one rule survives -- the old season-1 row is gone, not left
    // behind as an orphan -- and its mappings cascaded away with it.
    const rules = await pool.query('select id, season from rules');
    expect(rules.rows).toEqual([{ id: newRuleId, season: 2 }]);
    const mappings = await pool.query('select season, episode from mappings order by episode');
    expect(mappings.rows).toEqual([
      { season: 2, episode: 1 },
      { season: 2, episode: 2 },
    ]);
    await app.close();
  });

  it('fetches and caches TMDB season details when a tmdbId is given, then reuses the cache on a second save', async () => {
    vi.mocked(fetchExternalIds).mockResolvedValue({ imdbId: null, tvdbId: null });
    vi.mocked(fetchSeasonDetails).mockResolvedValue([
      { episode: 1, air_date: null },
      { episode: 2, air_date: null },
    ]);

    const app = build();
    const first = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        torrentHash: 'h1',
        season: 1,
        numbering: 'sequential',
        sort: 'natural',
        startEpisode: 1,
        title: { tmdbId: 42, nameRu: 'Show' },
      },
    });
    expect(first.statusCode).toBe(200);
    expect(fetchSeasonDetails).toHaveBeenCalledTimes(1);

    const cached = await pool.query('select episode_count from provider_seasons');
    expect(cached.rows[0].episode_count).toBe(2);

    // Second save for the same title+season+source must not re-fetch (cache hit).
    const second = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        torrentHash: 'h1',
        season: 1,
        numbering: 'sequential',
        sort: 'natural',
        startEpisode: 1,
        title: { tmdbId: 42, nameRu: 'Show' },
      },
    });
    expect(second.statusCode).toBe(200);
    expect(fetchSeasonDetails).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe.skipIf(!hasTestDb)('GET /api/library (real Postgres)', () => {
  beforeEach(async () => {
    vi.spyOn(config, 'adminUser', 'get').mockReturnValue('admin');
    vi.spyOn(config, 'adminPass', 'get').mockReturnValue('supersecret');
    await truncateAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('groups a mapped title by season with episode coverage and rules', async () => {
    const title = await pool.query(
      `insert into titles (name_ru, imdb_id) values ('Show', 'tt1234567') returning id`,
    );
    const titleId = title.rows[0].id as string;
    await pool.query(
      `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
       values ('h1', 1001, 'Show S01', now())`,
    );
    const rule = await pool.query(
      `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source)
       values ('h1', $1, 1, 'sequential', 'natural', 1, 1.0, 'manual') returning id`,
      [titleId],
    );
    const file = await pool.query(
      `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
       values ('h1', 1, '01.mp4', 100, true) returning id`,
    );
    await pool.query(
      `insert into mappings (file_id, title_id, season, episode, rule_id) values ($1, $2, 1, 1, $3)`,
      [file.rows[0].id, titleId, rule.rows[0].id],
    );

    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/library',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(1);
    expect(body[0].nameRu).toBe('Show');
    expect(body[0].seasons).toHaveLength(1);
    expect(body[0].seasons[0].mappedEpisodesCount).toBe(1);
    expect(body[0].seasons[0].episodes).toEqual([{ episode: 1, count: 1, files: ['01.mp4'] }]);
    expect(body[0].seasons[0].rules).toEqual([
      { id: rule.rows[0].id, torrentHash: 'h1', numbering: 'sequential', source: 'manual' },
    ]);
    await app.close();
  });
});

describe.skipIf(!hasTestDb)('GET /api/health (real Postgres)', () => {
  beforeEach(async () => {
    vi.spyOn(config, 'adminUser', 'get').mockReturnValue('admin');
    vi.spyOn(config, 'adminPass', 'get').mockReturnValue('supersecret');
    await truncateAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports gone torrents, dangling mappings, and recent plays', async () => {
    const title = await pool.query(
      `insert into titles (name_ru, imdb_id) values ('Show', 'tt1234567') returning id`,
    );
    const titleId = title.rows[0].id as string;
    await pool.query(
      `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen, status)
       values ('gone1', 1001, 'Gone Torrent', now(), 'gone')`,
    );
    const rule = await pool.query(
      `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source)
       values ('gone1', $1, 1, 'sequential', 'natural', 1, 1.0, 'manual') returning id`,
      [titleId],
    );
    const file = await pool.query(
      `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
       values ('gone1', 1, '01.mp4', 100, true) returning id`,
    );
    await pool.query(
      `insert into mappings (file_id, title_id, season, episode, rule_id) values ($1, $2, 1, 1, $3)`,
      [file.rows[0].id, titleId, rule.rows[0].id],
    );
    await pool.query(`insert into play_log (file_id, user_agent) values ($1, 'Stremio/1.0')`, [
      file.rows[0].id,
    ]);

    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.goneCount).toBe(1);
    expect(body.goneTorrents).toEqual([
      { hash: 'gone1', name: 'Gone Torrent', lastSeen: expect.any(String) },
    ]);
    expect(body.danglingMappings).toBe(1);
    expect(body.recentPlays).toHaveLength(1);
    expect(body.recentPlays[0]).toMatchObject({
      titleRu: 'Show',
      season: 1,
      episode: 1,
      rawPath: '01.mp4',
    });
    await app.close();
  });
});

afterAll(async () => {
  if (hasTestDb) await pool.end();
});
