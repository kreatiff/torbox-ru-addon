import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { build } from '../../src/http/server.js';
import { config } from '../../src/config.js';
import {
  searchTitles,
  fetchExternalIds,
  fetchSeasonDetails,
  resolveTitleIds,
} from '../../src/metadata/tmdb.js';
import { extractEpisodes } from '../../src/llm/opencodeZen.js';
import { hasTestDb, truncateAll } from '../db/testDb.js';
import { pool } from '../../src/db/pool.js';
import { runIngestDeduped } from '../../src/ingest/pipeline.js';
import type * as PipelineModule from '../../src/ingest/pipeline.js';

vi.mock('../../src/metadata/tmdb.js', () => ({
  searchTitles: vi.fn(),
  fetchExternalIds: vi.fn(),
  fetchSeasonDetails: vi.fn(),
  resolveTitleIds: vi.fn(),
}));

vi.mock('../../src/llm/opencodeZen.js', () => ({
  extractEpisodes: vi.fn(),
}));

vi.mock('../../src/ingest/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PipelineModule>();
  return { ...actual, runIngestDeduped: vi.fn() };
});

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

describe.skipIf(!hasTestDb)('POST /api/torrents/:hash/preview (real Postgres)', () => {
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
      method: 'POST',
      url: '/api/torrents/does-not-exist/preview',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('returns 400 when the torrent has no video files', async () => {
    await pool.query(
      `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
       values ('h1', 1, 'Show', now())`,
    );
    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/torrents/h1/preview',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when the LLM is unavailable (extractEpisodes resolves null)', async () => {
    await pool.query(
      `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
       values ('h1', 1, 'Show', now())`,
    );
    await pool.query(
      `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
       values ('h1', 1, '01.mp4', 1000, true)`,
    );
    vi.mocked(extractEpisodes).mockResolvedValue(null);

    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/torrents/h1/preview',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('returns 502 when the LLM call throws', async () => {
    await pool.query(
      `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
       values ('h1', 1, 'Show', now())`,
    );
    await pool.query(
      `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
       values ('h1', 1, '01.mp4', 1000, true)`,
    );
    vi.mocked(extractEpisodes).mockRejectedValue(new Error('network blip'));

    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/torrents/h1/preview',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(502);
    await app.close();
  });

  it('returns a commit-tier proposal for a confident LLM extraction, without persisting anything', async () => {
    await pool.query(`insert into titles (name_ru) values ('Show')`);
    const torrent = await pool.query(
      `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
       values ('h1', 1, 'rutor.info_Show [S01]', now()) returning hash`,
    );
    const files = await pool.query(
      `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
       values ('h1', 1, '01.mp4', 1000, true), ('h1', 2, '02.mp4', 1000, true)
       returning id`,
    );

    vi.mocked(extractEpisodes).mockImplementation(async (_torrentName, reqFiles) => ({
      title: 'Show',
      titleEn: null,
      year: null,
      season: 1,
      files: reqFiles.map((f, index) => ({ fileId: f.fileId, episode: index + 1 })),
      confident: true,
      reasoning: 'Sequentially numbered files, no ambiguity.',
    }));

    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: `/api/torrents/${torrent.rows[0].hash}/preview`,
      headers: { authorization: authHeader },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tier).toBe('commit');
    expect(body.confident).toBe(true);
    expect(body.proposal.season).toBe(1);
    expect(body.proposal.numbering).toBe('manual');
    expect(body.proposal.exceptions[String(files.rows[0].id)]).toEqual({ season: 1, episode: 1 });
    expect(body.title.nameRu).toBe('Show');

    // Nothing persisted -- this is a preview, not an accept.
    const rulesCount = await pool.query('select count(*) from rules');
    const mappingsCount = await pool.query('select count(*) from mappings');
    expect(Number(rulesCount.rows[0].count)).toBe(0);
    expect(Number(mappingsCount.rows[0].count)).toBe(0);

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

  it("rejects numbering 'parsed' with 400 when the torrent name can't be resolved", async () => {
    // 'parsed' needs a torrent name for expandParsed to re-run the cascade
    // against (§Milestone 5). 'h-unknown' has no torrents row and the
    // request supplies no torrentName override, so there's nothing to
    // resolve it from.
    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        torrentHash: 'h-unknown',
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

  it("accepts numbering 'parsed' and materialises mappings from the real cascade when the torrent name resolves", async () => {
    await pool.query(
      `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
       values ('h-parsed', 2001, 'Parsed Show', now())`,
    );
    await pool.query(
      `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
       values ('h-parsed', 1, 'Parsed.Show.s01.E01.mp4', 100, true),
              ('h-parsed', 2, 'Parsed.Show.s01.E02.mp4', 100, true)`,
    );

    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        torrentHash: 'h-parsed',
        season: 1,
        numbering: 'parsed',
        sort: 'natural',
        startEpisode: 1,
        title: { nameRu: 'Parsed Show' },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);

    const mappings = await pool.query(
      `select m.season, m.episode from mappings m
       join rules r on r.id = m.rule_id
       where r.torrent_hash = 'h-parsed' order by m.episode`,
    );
    expect(mappings.rows).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
    ]);
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

  it('includes tvdbId alongside imdbId/tmdbId, for reliable cross-service matching', async () => {
    await pool.query(
      `insert into titles (name_ru, imdb_id, tvdb_id, tmdb_id) values ('Show', 'tt1234567', 555, 42)`,
    );

    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/library',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body[0]).toMatchObject({ imdbId: 'tt1234567', tvdbId: 555, tmdbId: 42 });
    await app.close();
  });
});

describe.skipIf(!hasTestDb)('GET /api/titles/resolve (real Postgres)', () => {
  beforeEach(() => {
    vi.spyOn(config, 'adminUser', 'get').mockReturnValue('admin');
    vi.spyOn(config, 'adminPass', 'get').mockReturnValue('supersecret');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a request with none of tmdbId/imdbId/tvdbId', async () => {
    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/titles/resolve',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('cross-resolves an imdbId to the other provider ids via TMDB', async () => {
    vi.mocked(resolveTitleIds).mockResolvedValue({
      tmdbId: 42,
      imdbId: 'tt1234567',
      tvdbId: 555,
      nameRu: 'Show',
      nameEn: 'Show EN',
      year: 2020,
      posterUrl: null,
    });

    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/titles/resolve?imdbId=tt1234567',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tmdbId: 42,
      imdbId: 'tt1234567',
      tvdbId: 555,
      nameRu: 'Show',
      nameEn: 'Show EN',
      year: 2020,
      posterUrl: null,
    });
    expect(resolveTitleIds).toHaveBeenCalledWith({ tmdbId: null, imdbId: 'tt1234567', tvdbId: null });
    await app.close();
  });
});

describe.skipIf(!hasTestDb)('POST /api/titles (real Postgres)', () => {
  beforeEach(async () => {
    vi.spyOn(config, 'adminUser', 'get').mockReturnValue('admin');
    vi.spyOn(config, 'adminPass', 'get').mockReturnValue('supersecret');
    await truncateAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('manually adds a title without any torrent/rule attached', async () => {
    vi.mocked(resolveTitleIds).mockResolvedValue({
      tmdbId: null,
      imdbId: null,
      tvdbId: null,
      nameRu: null,
      nameEn: null,
      year: null,
      posterUrl: null,
    });

    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/titles',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { nameRu: 'Manually Added Show', year: 2021 },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.title.nameRu).toBe('Manually Added Show');

    const rows = await pool.query('select name_ru, year from titles');
    expect(rows.rows).toEqual([{ name_ru: 'Manually Added Show', year: 2021 }]);
    await app.close();
  });

  it('backfills imdb/tvdb ids from a manually entered tmdbId', async () => {
    vi.mocked(resolveTitleIds).mockResolvedValue({
      tmdbId: 42,
      imdbId: 'tt1234567',
      tvdbId: 555,
      nameRu: 'Show',
      nameEn: null,
      year: 2020,
      posterUrl: null,
    });

    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/titles',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { nameRu: 'Show', tmdbId: 42 },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.title.imdbId).toBe('tt1234567');
    expect(body.title.tvdbId).toBe(555);
    await app.close();
  });

  it('rejects an empty nameRu with 400', async () => {
    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/titles',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { nameRu: '' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('reuses the existing title instead of creating a duplicate when the resolved tmdbId already exists', async () => {
    const existing = await pool.query(
      `insert into titles (name_ru, tmdb_id) values ('Existing', 42) returning id`,
    );
    vi.mocked(resolveTitleIds).mockResolvedValue({
      tmdbId: 42,
      imdbId: 'tt9999999',
      tvdbId: null,
      nameRu: 'Existing',
      nameEn: null,
      year: null,
      posterUrl: null,
    });

    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/titles',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { nameRu: 'New name', imdbId: 'tt9999999' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().title.id).toBe(existing.rows[0].id);

    const count = await pool.query('select count(*) from titles');
    expect(Number(count.rows[0].count)).toBe(1);
    await app.close();
  });
});

describe.skipIf(!hasTestDb)('PATCH /api/titles/:id (real Postgres)', () => {
  beforeEach(async () => {
    vi.spyOn(config, 'adminUser', 'get').mockReturnValue('admin');
    vi.spyOn(config, 'adminPass', 'get').mockReturnValue('supersecret');
    await truncateAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updates only the provided fields on an existing title', async () => {
    const inserted = await pool.query(
      `insert into titles (name_ru, year) values ('Old Name', 2019) returning id`,
    );
    const titleId = inserted.rows[0].id as string;

    const app = build();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/titles/${titleId}`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { imdbId: 'tt1234567' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.title.imdbId).toBe('tt1234567');
    expect(body.title.nameRu).toBe('Old Name');
    expect(body.title.year).toBe(2019);
    await app.close();
  });

  it('404s for a missing title id', async () => {
    const app = build();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/titles/00000000-0000-0000-0000-000000000000',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { imdbId: 'tt1234567' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('409s when the new imdbId already belongs to a different title', async () => {
    await pool.query(`insert into titles (name_ru, imdb_id) values ('Other', 'tt1111111')`);
    const inserted = await pool.query(`insert into titles (name_ru) values ('Mine') returning id`);
    const titleId = inserted.rows[0].id as string;

    const app = build();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/titles/${titleId}`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { imdbId: 'tt1111111' },
    });
    expect(response.statusCode).toBe(409);
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

describe.skipIf(!hasTestDb)('GET/POST /api/feed/:topicId/download (real Postgres)', () => {
  beforeEach(async () => {
    vi.spyOn(config, 'adminUser', 'get').mockReturnValue('admin');
    vi.spyOn(config, 'adminPass', 'get').mockReturnValue('supersecret');
    vi.spyOn(config, 'flaresolverrUrl', 'get').mockReturnValue('http://localhost:8191');
    await truncateAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function seedFeedEntry(topicId: number): Promise<void> {
    const title = await pool.query(`insert into titles (name_ru) values ('Большой куш') returning id`);
    await pool.query(
      `insert into feed_entries (topic_id, title_id, raw_title, url, last_updated)
       values ($1, $2, 'Большой куш. Бангкок 2 сезон: 5 выпуск', $3, now())`,
      [topicId, title.rows[0].id, `https://rutracker.org/forum/viewtopic.php?t=${topicId}`],
    );
  }

  function stubFlareSolverrAndTorBox(magnet: string) {
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
            JSON.stringify({ success: true, data: { torrent_id: 1, hash: 'abc' } }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch in test: ${url}`);
      }),
    );
  }

  it('POST downloads a matched entry end to end and marks it downloaded', async () => {
    await seedFeedEntry(1);
    stubFlareSolverrAndTorBox('magnet:?xt=urn:btih:ABC');

    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/feed/1/download',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      alreadyDownloaded: false,
      rawTitle: 'Большой куш. Бангкок 2 сезон: 5 выпуск',
    });

    const row = await pool.query('select downloaded_at from feed_entries where topic_id = 1');
    expect(row.rows[0].downloaded_at).not.toBeNull();
    await app.close();
  });

  it('POST is idempotent: a second call short-circuits without calling FlareSolverr/TorBox again', async () => {
    await seedFeedEntry(2);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(':8191')) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            solution: { response: '<a href="magnet:?xt=urn:btih:ABC">m</a>' },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ success: true, data: { torrent_id: 1, hash: 'abc' } }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = build();
    const first = await app.inject({
      method: 'POST',
      url: '/api/feed/2/download',
      headers: { authorization: authHeader },
    });
    expect(first.json().alreadyDownloaded).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2); // FlareSolverr + TorBox

    const second = await app.inject({
      method: 'POST',
      url: '/api/feed/2/download',
      headers: { authorization: authHeader },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({
      success: true,
      alreadyDownloaded: true,
      rawTitle: 'Большой куш. Бангкок 2 сезон: 5 выпуск',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2); // unchanged -- no re-fetch
    await app.close();
  });

  it('POST returns 200 {success:false} (not a 5xx) when FlareSolverr cannot resolve a magnet', async () => {
    await seedFeedEntry(3);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok', solution: { response: '' } }), {
        status: 200,
      })),
    );

    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/feed/3/download',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: false,
      error: 'No magnet link found on the topic page',
    });
    await app.close();
  });

  it('POST rejects a non-numeric topicId with 400', async () => {
    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/feed/not-a-number/download',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('GET renders an HTML confirmation page (for the Discord link) and still requires Basic Auth', async () => {
    await seedFeedEntry(4);
    stubFlareSolverrAndTorBox('magnet:?xt=urn:btih:ABC');

    const app = build();

    const unauthenticated = await app.inject({ method: 'GET', url: '/api/feed/4/download' });
    expect(unauthenticated.statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: '/api/feed/4/download',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Added to TorBox');
    expect(response.body).toContain('Большой куш'); // HTML-escaped-safe Cyrillic renders fine
    await app.close();
  });

  it('GET HTML-escapes the raw title so a crafted feed title cannot inject markup', async () => {
    const title = await pool.query(`insert into titles (name_ru) values ('X') returning id`);
    await pool.query(
      `insert into feed_entries (topic_id, title_id, raw_title, url, last_updated)
       values (5, $1, '<script>alert(1)</script>', 'https://rutracker.org/forum/viewtopic.php?t=5', now())`,
      [title.rows[0].id],
    );
    stubFlareSolverrAndTorBox('magnet:?xt=urn:btih:ABC');

    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/feed/5/download',
      headers: { authorization: authHeader },
    });
    expect(response.body).not.toContain('<script>');
    expect(response.body).toContain('&lt;script&gt;');
    await app.close();
  });
});

describe.skipIf(!hasTestDb)('GET /api/feed season/episode/alreadyInLibrary (real Postgres)', () => {
  beforeEach(async () => {
    vi.spyOn(config, 'adminUser', 'get').mockReturnValue('admin');
    vi.spyOn(config, 'adminPass', 'get').mockReturnValue('supersecret');
    await truncateAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('derives season/episode from raw_title and flags an entry whose episode is already mapped', async () => {
    const title = await pool.query(`insert into titles (name_ru) values ('Большой куш') returning id`);
    const titleId = title.rows[0].id as string;

    // Already in the library: a torrent mapped to S02E05 for this title.
    await pool.query(
      `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen) values ('h1', 1, 'x', now())`,
    );
    const file = await pool.query(
      `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
       values ('h1', 1, '05.mp4', 1, true) returning id`,
    );
    const rule = await pool.query(
      `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source)
       values ('h1', $1, 1, 'sequential', 'natural', 1, 1.0, 'manual') returning id`,
      [titleId],
    );
    await pool.query(`insert into mappings (file_id, title_id, season, episode, rule_id) values ($1, $2, 2, 5, $3)`, [
      file.rows[0].id,
      titleId,
      rule.rows[0].id,
    ]);

    // Two feed entries: one for the already-mapped S02E05, one for a new S02E06.
    await pool.query(
      `insert into feed_entries (topic_id, title_id, raw_title, url, last_updated) values
       (1, $1, 'Большой куш. Бангкок 2 сезон: 5 выпуск [2026]', 'https://rutracker.org/forum/viewtopic.php?t=1', now()),
       (2, $1, 'Большой куш. Бангкок 2 сезон: 6 выпуск [2026]', 'https://rutracker.org/forum/viewtopic.php?t=2', now())`,
      [titleId],
    );

    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/feed',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      topicId: number;
      season: number | null;
      episode: number | null;
      alreadyInLibrary: boolean;
    }[];
    const entry1 = body.find((e) => e.topicId === 1);
    const entry2 = body.find((e) => e.topicId === 2);
    expect(entry1).toMatchObject({ season: 2, episode: 5, alreadyInLibrary: true });
    expect(entry2).toMatchObject({ season: 2, episode: 6, alreadyInLibrary: false });
    await app.close();
  });

  it('never flags an unmatched entry (no title_id) as already in library', async () => {
    await pool.query(
      `insert into feed_entries (topic_id, title_id, raw_title, url, last_updated) values
       (3, null, 'Погоня 2 сезон: 3 выпуск [2026]', 'https://rutracker.org/forum/viewtopic.php?t=3', now())`,
    );

    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/feed',
      headers: { authorization: authHeader },
    });
    const body = response.json() as { topicId: number; alreadyInLibrary: boolean }[];
    expect(body.find((e) => e.topicId === 3)).toMatchObject({ alreadyInLibrary: false });
    await app.close();
  });
});

describe.skipIf(!hasTestDb)('POST /api/feed/:topicId/match (real Postgres)', () => {
  beforeEach(async () => {
    vi.spyOn(config, 'adminUser', 'get').mockReturnValue('admin');
    vi.spyOn(config, 'adminPass', 'get').mockReturnValue('supersecret');
    await truncateAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('assigns a manual match and the entry shows up matched on the next read', async () => {
    await pool.query(
      `insert into feed_entries (topic_id, title_id, raw_title, url, last_updated) values
       (10, null, 'Погоня 2 сезон: 3 выпуск', 'https://rutracker.org/forum/viewtopic.php?t=10', now())`,
    );
    const title = await pool.query(`insert into titles (name_ru) values ('Погоня') returning id`);

    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/feed/10/match',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { titleId: title.rows[0].id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    const row = await pool.query('select title_id from feed_entries where topic_id = 10');
    expect(row.rows[0].title_id).toBe(title.rows[0].id);
    await app.close();
  });

  it('returns 200 {success:false} (not a 5xx) for a title id that does not exist', async () => {
    await pool.query(
      `insert into feed_entries (topic_id, title_id, raw_title, url, last_updated) values
       (11, null, 'Show', 'https://rutracker.org/forum/viewtopic.php?t=11', now())`,
    );

    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/feed/11/match',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { titleId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: false, error: 'No such feed entry or title' });
    await app.close();
  });

  it('rejects a non-numeric topicId with 400', async () => {
    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/feed/not-a-number/match',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { titleId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a missing titleId with 400', async () => {
    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/feed/12/match',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /api/ingest/run', () => {
  beforeEach(() => {
    vi.spyOn(config, 'adminUser', 'get').mockReturnValue('admin');
    vi.spyOn(config, 'adminPass', 'get').mockReturnValue('supersecret');
    vi.mocked(runIngestDeduped).mockReset().mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('triggers a deduped ingest run in the background', async () => {
    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/ingest/run',
      headers: { authorization: authHeader },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, message: 'Ingest run triggered in background' });
    expect(runIngestDeduped).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

afterAll(async () => {
  if (hasTestDb) await pool.end();
});
