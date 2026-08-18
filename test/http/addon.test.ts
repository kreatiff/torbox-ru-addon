import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { hasTestDb, truncateAll } from '../db/testDb.js';
import { pool } from '../../src/db/pool.js';
import { config } from '../../src/config.js';
import { build } from '../../src/http/server.js';
import { parseStreamId } from '../../src/http/routes/addon/stream.js';

interface SeedOptions {
  confidence?: number;
}

async function seedEpisode(options: SeedOptions = {}): Promise<{ imdbId: string; fileId: number }> {
  const imdbId = 'tt1234567';
  const title = await pool.query(
    `insert into titles (name_ru, imdb_id) values ('Show', $1) returning id`,
    [imdbId],
  );
  const titleId = title.rows[0].id as string;
  await pool.query(
    `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
     values ('h1', 1001, 'Show S03 Real Torrent Name', now())`,
  );
  const rule = await pool.query(
    `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source)
     values ('h1', $1, 3, 'sequential', 'natural', 1, $2, 'manual') returning id`,
    [titleId, options.confidence ?? 1.0],
  );
  const ruleId = rule.rows[0].id as string;
  const files = await pool.query(
    `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
     values ('h1', 1, '01.mp4', 5000000000, true) returning id`,
  );
  const fileId = files.rows[0].id as number;
  await pool.query(
    `insert into mappings (file_id, title_id, season, episode, rule_id) values ($1, $2, 3, 1, $3)`,
    [fileId, titleId, ruleId],
  );
  return { imdbId, fileId };
}

describe('addon routes: manifest + token auth (no DB needed)', () => {
  it('serves a series-only manifest for a valid token', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'GET',
      url: `/${config.addonToken}/manifest.json`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.types).toEqual(['series']);
    expect(body.resources).toEqual(['stream']);
    expect(body.idPrefixes).toEqual(['tt', 'tmdb:']);
    await app.close();
  });

  it('LOCKED (§5.5): rejects a wrong token with 404, not 401/403', async () => {
    const app = await build();
    const response = await app.inject({ method: 'GET', url: '/wrong-token/manifest.json' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a request missing the token segment entirely with 404', async () => {
    const app = await build();
    const response = await app.inject({ method: 'GET', url: '/manifest.json' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe('parseStreamId (pure, no DB needed)', () => {
  it('parses an imdb-shaped id', () => {
    expect(parseStreamId('tt1234567:3:8')).toEqual({
      scheme: 'imdb',
      id: 'tt1234567',
      season: 3,
      episode: 8,
    });
  });

  it('parses a tmdb-shaped id -- AIOStreams sometimes resolves via TMDB, not IMDb', () => {
    expect(parseStreamId('tmdb:250793:3:3')).toEqual({
      scheme: 'tmdb',
      id: 250793,
      season: 3,
      episode: 3,
    });
  });

  it.each([
    ['tt1234567', 'too few parts'],
    ['tt1234567:3', 'too few parts'],
    ['tt1234567:3:8:extra', 'too many parts, not tmdb-prefixed'],
    ['tt1234567:x:8', 'non-numeric season'],
    ['tt1234567:3:x', 'non-numeric episode'],
    ['tmdb:x:3:8', 'non-numeric tmdb id'],
    ['tmdb:250793:x:8', 'non-numeric season (tmdb)'],
    [':3:8', 'empty imdb id'],
  ])('returns null for %s (%s)', (input) => {
    expect(parseStreamId(input)).toBeNull();
  });
});

describe.skipIf(!hasTestDb)('addon routes: stream resolution (real Postgres)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('resolves a mapped episode to a stream pointing at /play/:fileId', async () => {
    const { imdbId, fileId } = await seedEpisode();
    const app = await build();
    const response = await app.inject({
      method: 'GET',
      url: `/${config.addonToken}/stream/series/${imdbId}:3:1.json`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.streams).toHaveLength(1);
    const [stream] = body.streams;
    expect(stream.url).toBe(`${config.publicBase}/${config.addonToken}/play/${fileId}`);
    expect(stream.behaviorHints.bingeGroup).toMatch(/^torbox-ru-.+-3$/);
    expect(stream.behaviorHints.notWebReady).toBe(false);
    expect(stream.description).toContain('Show S03 Real Torrent Name');
    expect(stream.description).not.toContain('⚠');
    await app.close();
  });

  it('flags a low-confidence mapping with ⚠ in the description', async () => {
    const { imdbId } = await seedEpisode({ confidence: 0.5 });
    const app = await build();
    const response = await app.inject({
      method: 'GET',
      url: `/${config.addonToken}/stream/series/${imdbId}:3:1.json`,
    });
    expect(response.json().streams[0].description).toContain('⚠');
    await app.close();
  });

  it('flags notWebReady for a .ts file', async () => {
    await pool.query(`insert into titles (name_ru, imdb_id) values ('Show', 'tt7654321')`);
    const titleId = (await pool.query(`select id from titles where imdb_id = 'tt7654321'`)).rows[0]
      .id as string;
    await pool.query(
      `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
       values ('h2', 1002, 'Show', now())`,
    );
    const rule = await pool.query(
      `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source)
       values ('h2', $1, 1, 'sequential', 'natural', 1, 1.0, 'manual') returning id`,
      [titleId],
    );
    const file = await pool.query(
      `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
       values ('h2', 1, '01.ts', 100, true) returning id`,
    );
    await pool.query(
      `insert into mappings (file_id, title_id, season, episode, rule_id) values ($1, $2, 1, 1, $3)`,
      [file.rows[0].id, titleId, rule.rows[0].id],
    );

    const app = await build();
    const response = await app.inject({
      method: 'GET',
      url: `/${config.addonToken}/stream/series/tt7654321:1:1.json`,
    });
    expect(response.json().streams[0].behaviorHints.notWebReady).toBe(true);
    await app.close();
  });

  it('resolves a tmdb-sourced id the same as an imdb one (found verifying against a real account)', async () => {
    const tmdbId = 250793;
    const title = await pool.query(
      `insert into titles (name_ru, tmdb_id) values ('Show', $1) returning id`,
      [tmdbId],
    );
    const titleId = title.rows[0].id as string;
    await pool.query(
      `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
       values ('h3', 1003, 'Show', now())`,
    );
    const rule = await pool.query(
      `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source)
       values ('h3', $1, 3, 'sequential', 'natural', 1, 1.0, 'manual') returning id`,
      [titleId],
    );
    const file = await pool.query(
      `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
       values ('h3', 1, '01.mp4', 100, true) returning id`,
    );
    await pool.query(
      `insert into mappings (file_id, title_id, season, episode, rule_id) values ($1, $2, 3, 3, $3)`,
      [file.rows[0].id, titleId, rule.rows[0].id],
    );

    const app = await build();
    const response = await app.inject({
      method: 'GET',
      url: `/${config.addonToken}/stream/series/tmdb:${tmdbId}:3:3.json`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().streams).toHaveLength(1);
    await app.close();
  });

  it('returns an empty stream list for an unknown imdb id', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'GET',
      url: `/${config.addonToken}/stream/series/tt9999999:1:1.json`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ streams: [] });
    await app.close();
  });

  it('returns an empty stream list for a known title with no mapping for that episode', async () => {
    const { imdbId } = await seedEpisode();
    const app = await build();
    const response = await app.inject({
      method: 'GET',
      url: `/${config.addonToken}/stream/series/${imdbId}:3:99.json`,
    });
    expect(response.json()).toEqual({ streams: [] });
    await app.close();
  });

  it('404s for a type other than series -- out of contract, not just "no results"', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'GET',
      url: `/${config.addonToken}/stream/movie/tt1234567.json`,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
