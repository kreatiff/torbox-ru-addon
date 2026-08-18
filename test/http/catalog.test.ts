import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { hasTestDb, truncateAll } from '../db/testDb.js';
import { pool } from '../../src/db/pool.js';
import { config } from '../../src/config.js';
import { build } from '../../src/http/server.js';
import { CATALOG_ID } from '../../src/http/routes/addon/manifest.js';
import {
  stremioIdForTitle,
  parseSyntheticId,
  isValidUuid,
  parseCatalogExtra,
  matchesSearch,
} from '../../src/http/catalogMapper.js';

function kinopoiskJson(
  body: unknown,
  ok = true,
  status = 200,
): { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> } {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** Routes the three Kinopoisk endpoints withKinopoiskEnrichment hits
 * (search-by-imdb, film detail, staff) to canned responses, mirroring the
 * live shape verified in test/metadata/kinopoisk.test.ts. */
function mockKinopoiskFetch(kinopoiskId = 326) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/v2.2/films?')) {
      return Promise.resolve(kinopoiskJson({ items: [{ kinopoiskId }] }));
    }
    if (url.includes(`/api/v2.2/films/${kinopoiskId}`)) {
      return Promise.resolve(
        kinopoiskJson({
          description: 'Тестовое описание',
          posterUrl: 'https://example.com/kp-poster.jpg',
          genres: [{ genre: 'драма' }],
        }),
      );
    }
    if (url.includes('/api/v1/staff')) {
      return Promise.resolve(
        kinopoiskJson([{ nameRu: 'Тестовый актёр', nameEn: null, professionKey: 'ACTOR' }]),
      );
    }
    throw new Error(`unexpected Kinopoisk URL in test: ${url}`);
  });
}

describe('catalogMapper (pure, no DB needed)', () => {
  describe('stremioIdForTitle', () => {
    it('prefers imdbId when present', () => {
      expect(stremioIdForTitle({ id: 'uuid-1', imdbId: 'tt1234567' })).toBe('tt1234567');
    });

    it('falls back to the synthetic torboxru: scheme when there is no imdbId', () => {
      expect(stremioIdForTitle({ id: 'uuid-1', imdbId: null })).toBe('torboxru:uuid-1');
    });
  });

  describe('parseSyntheticId / isValidUuid', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';

    it('extracts a valid uuid from a torboxru: id', () => {
      expect(parseSyntheticId(`torboxru:${uuid}`)).toBe(uuid);
    });

    it('rejects a non-torboxru id', () => {
      expect(parseSyntheticId('tt1234567')).toBeNull();
    });

    it('rejects a torboxru id with a malformed uuid -- must 404, never reach the DB', () => {
      expect(parseSyntheticId('torboxru:not-a-uuid')).toBeNull();
    });

    it.each(['', '123', '11111111-2222-3333-4444', uuid.toUpperCase() + 'x'])(
      'isValidUuid rejects %s',
      (value) => {
        expect(isValidUuid(value)).toBe(false);
      },
    );

    it('isValidUuid accepts a well-formed (also uppercase) uuid', () => {
      expect(isValidUuid(uuid)).toBe(true);
      expect(isValidUuid(uuid.toUpperCase())).toBe(true);
    });
  });

  describe('parseCatalogExtra', () => {
    it('defaults to skip: 0 with no extra segment', () => {
      expect(parseCatalogExtra(undefined)).toEqual({ skip: 0 });
    });

    it('parses skip alone', () => {
      expect(parseCatalogExtra('skip=100')).toEqual({ skip: 100 });
    });

    it('parses search alone', () => {
      expect(parseCatalogExtra('search=foo')).toEqual({ search: 'foo', skip: 0 });
    });

    it('parses search and skip together', () => {
      expect(parseCatalogExtra('search=foo&skip=20')).toEqual({ search: 'foo', skip: 20 });
    });

    it('clamps a negative or non-numeric skip to 0', () => {
      expect(parseCatalogExtra('skip=-5')).toEqual({ skip: 0 });
      expect(parseCatalogExtra('skip=abc')).toEqual({ skip: 0 });
    });
  });

  describe('matchesSearch', () => {
    it('matches a ё/е variant of name_ru via normalise()', () => {
      const title = { nameRu: 'Ёжик в тумане', nameEn: null, aliases: [] };
      expect(matchesSearch(title, 'Ежик')).toBe(true);
    });

    it('matches name_en', () => {
      const title = { nameRu: 'Шоу', nameEn: 'The Show', aliases: [] };
      expect(matchesSearch(title, 'the show')).toBe(true);
    });

    it('returns false when nothing matches', () => {
      const title = { nameRu: 'Шоу', nameEn: null, aliases: [] };
      expect(matchesSearch(title, 'unrelated')).toBe(false);
    });
  });
});

interface SeededTitle {
  titleId: string;
  fileId: number;
}

async function seedMappedTitle(options: {
  nameRu: string;
  hash: string;
  imdbId?: string;
  tmdbId?: number;
  posterUrl?: string;
  season?: number;
  episode?: number;
  ruleCreatedAt?: string;
}): Promise<SeededTitle> {
  const season = options.season ?? 1;
  const episode = options.episode ?? 1;
  const title = await pool.query(
    `insert into titles (name_ru, imdb_id, tmdb_id, poster_url) values ($1, $2, $3, $4) returning id`,
    [options.nameRu, options.imdbId ?? null, options.tmdbId ?? null, options.posterUrl ?? null],
  );
  const titleId = title.rows[0].id as string;
  await pool.query(
    `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
     values ($1, 1, 'Torrent', now())`,
    [options.hash],
  );
  const rule = await pool.query(
    `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source, created_at)
     values ($1, $2, $3, 'sequential', 'natural', 1, 1.0, 'manual', coalesce($4::timestamptz, now())) returning id`,
    [options.hash, titleId, season, options.ruleCreatedAt ?? null],
  );
  const file = await pool.query(
    `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
     values ($1, 1, '01.mp4', 100, true) returning id`,
    [options.hash],
  );
  const fileId = file.rows[0].id as number;
  await pool.query(
    `insert into mappings (file_id, title_id, season, episode, rule_id) values ($1, $2, $3, $4, $5)`,
    [fileId, titleId, season, episode, rule.rows[0].id],
  );
  return { titleId, fileId };
}

describe.skipIf(!hasTestDb)('addon routes: catalog + meta (real Postgres)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('GET /:token/catalog/series/:catalogId.json', () => {
    it('lists a mapped title with imdb_id as a tt-prefixed card carrying its poster', async () => {
      await seedMappedTitle({
        nameRu: 'Show With Imdb',
        hash: 'h1',
        imdbId: 'tt1234567',
        posterUrl: 'https://example.com/poster.jpg',
      });
      const app = build();
      const response = await app.inject({
        method: 'GET',
        url: `/${config.addonToken}/catalog/series/${CATALOG_ID}.json`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.metas).toHaveLength(1);
      expect(body.metas[0]).toMatchObject({
        id: 'tt1234567',
        type: 'series',
        name: 'Show With Imdb',
        poster: 'https://example.com/poster.jpg',
      });
      await app.close();
    });

    it('lists a mapped title with only tmdb_id as a torboxru:<uuid> card', async () => {
      const { titleId } = await seedMappedTitle({
        nameRu: 'Show Without Imdb',
        hash: 'h1',
        tmdbId: 555,
      });
      const app = build();
      const response = await app.inject({
        method: 'GET',
        url: `/${config.addonToken}/catalog/series/${CATALOG_ID}.json`,
      });
      const body = response.json();
      expect(body.metas[0].id).toBe(`torboxru:${titleId}`);
      await app.close();
    });

    it('excludes an unmapped title', async () => {
      await pool.query(`insert into titles (name_ru) values ('Unmapped Show')`);
      const app = build();
      const response = await app.inject({
        method: 'GET',
        url: `/${config.addonToken}/catalog/series/${CATALOG_ID}.json`,
      });
      expect(response.json().metas).toEqual([]);
      await app.close();
    });

    it('orders by most recently mapped first', async () => {
      await seedMappedTitle({
        nameRu: 'Older Show',
        hash: 'h1',
        imdbId: 'tt0000001',
        ruleCreatedAt: '2020-01-01T00:00:00Z',
      });
      await seedMappedTitle({
        nameRu: 'Newer Show',
        hash: 'h2',
        imdbId: 'tt0000002',
        ruleCreatedAt: '2024-01-01T00:00:00Z',
      });
      const app = build();
      const response = await app.inject({
        method: 'GET',
        url: `/${config.addonToken}/catalog/series/${CATALOG_ID}.json`,
      });
      expect(response.json().metas.map((m: { name: string }) => m.name)).toEqual([
        'Newer Show',
        'Older Show',
      ]);
      await app.close();
    });

    it('paginates via the skip extra', async () => {
      for (let i = 0; i < 3; i++) {
        await seedMappedTitle({
          nameRu: `Show ${i}`,
          hash: `h${i}`,
          imdbId: `tt000000${i}`,
          ruleCreatedAt: `202${i}-01-01T00:00:00Z`,
        });
      }
      const app = build();
      const response = await app.inject({
        method: 'GET',
        url: `/${config.addonToken}/catalog/series/${CATALOG_ID}/skip=1.json`,
      });
      const names = response.json().metas.map((m: { name: string }) => m.name);
      expect(names).toEqual(['Show 1', 'Show 0']);
      await app.close();
    });

    it('search matches an english name and a ё/е variant of the russian name', async () => {
      await seedMappedTitle({ nameRu: 'Ёжик в тумане', hash: 'h1', imdbId: 'tt0000001' });
      await seedMappedTitle({
        nameRu: 'Другое шоу',
        hash: 'h2',
        imdbId: 'tt0000002',
      });
      const app = build();
      const response = await app.inject({
        method: 'GET',
        url: `/${config.addonToken}/catalog/series/${CATALOG_ID}/${encodeURIComponent('search=Ежик')}.json`,
      });
      const names = response.json().metas.map((m: { name: string }) => m.name);
      expect(names).toEqual(['Ёжик в тумане']);
      await app.close();
    });

    it('caps a page at 100 even when more than 100 titles are mapped', async () => {
      const count = 101;
      const imdbIds = Array.from({ length: count }, (_, i) => `tt${String(i).padStart(7, '0')}`);
      const names = imdbIds.map((id) => `Show ${id}`);
      const hashes = imdbIds.map((id) => `hash-${id}`);

      const titlesResult = await pool.query(
        `insert into titles (name_ru, imdb_id)
         select * from unnest($1::text[], $2::text[])
         returning id, imdb_id`,
        [names, imdbIds],
      );
      const titleIdByImdb = new Map<string, string>(
        titlesResult.rows.map((r) => [r.imdb_id as string, r.id as string]),
      );
      const titleIds = imdbIds.map((id) => titleIdByImdb.get(id) as string);

      await pool.query(
        `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
         select h, row_number() over (), 'Torrent', now() from unnest($1::text[]) as h`,
        [hashes],
      );

      const rulesResult = await pool.query(
        `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source)
         select h, t, 1, 'sequential', 'natural', 1, 1.0, 'manual'
         from unnest($1::text[], $2::uuid[]) as x(h, t)
         returning id, torrent_hash`,
        [hashes, titleIds],
      );
      const ruleIdByHash = new Map<string, string>(
        rulesResult.rows.map((r) => [r.torrent_hash as string, r.id as string]),
      );

      const filesResult = await pool.query(
        `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
         select h, 1, '01.mp4', 100, true from unnest($1::text[]) as h
         returning id, torrent_hash`,
        [hashes],
      );
      const fileIdByHash = new Map<string, number>(
        filesResult.rows.map((r) => [r.torrent_hash as string, r.id as number]),
      );

      const fileIds = hashes.map((h) => fileIdByHash.get(h) as number);
      const ruleIds = hashes.map((h) => ruleIdByHash.get(h) as string);
      await pool.query(
        `insert into mappings (file_id, title_id, season, episode, rule_id)
         select * from unnest($1::bigint[], $2::uuid[], $3::int[], $4::int[], $5::uuid[])`,
        [fileIds, titleIds, hashes.map(() => 1), hashes.map(() => 1), ruleIds],
      );

      const app = build();
      const response = await app.inject({
        method: 'GET',
        url: `/${config.addonToken}/catalog/series/${CATALOG_ID}.json`,
      });
      expect(response.json().metas).toHaveLength(100);
      await app.close();
    });

    it('404s for a catalog id other than the declared one', async () => {
      const app = build();
      const response = await app.inject({
        method: 'GET',
        url: `/${config.addonToken}/catalog/series/not-the-real-catalog.json`,
      });
      expect(response.statusCode).toBe(404);
      await app.close();
    });

    it('404s for a wrong token', async () => {
      const app = build();
      const response = await app.inject({
        method: 'GET',
        url: `/wrong-token/catalog/series/${CATALOG_ID}.json`,
      });
      expect(response.statusCode).toBe(404);
      await app.close();
    });
  });

  describe('GET /:token/meta/series/:idJson', () => {
    it('returns videos[] matching the mapped episodes', async () => {
      const { titleId } = await seedMappedTitle({
        nameRu: 'Show Without Imdb',
        hash: 'h1',
        tmdbId: 555,
        season: 2,
        episode: 5,
      });
      const app = build();
      const response = await app.inject({
        method: 'GET',
        url: `/${config.addonToken}/meta/series/torboxru:${titleId}.json`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.meta.id).toBe(`torboxru:${titleId}`);
      expect(body.meta.videos).toEqual([
        {
          id: `torboxru:${titleId}:2:5`,
          title: 'S02E05',
          season: 2,
          episode: 5,
        },
      ]);
      await app.close();
    });

    it('404s for an unknown tt id -- we only answer for titles actually in the library', async () => {
      const app = build();
      const response = await app.inject({
        method: 'GET',
        url: `/${config.addonToken}/meta/series/tt1234567.json`,
      });
      expect(response.statusCode).toBe(404);
      await app.close();
    });

    describe('issue #28: serves tt-id titles too, with Kinopoisk enrichment', () => {
      const originalFetch = global.fetch;

      afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
      });

      it("serves meta for a tt-id title, reversing #20's Cinemeta-wins default", async () => {
        await seedMappedTitle({
          nameRu: 'Show With Imdb',
          hash: 'h1',
          imdbId: 'tt2000001',
          season: 1,
          episode: 1,
        });
        const app = build();
        const response = await app.inject({
          method: 'GET',
          url: `/${config.addonToken}/meta/series/tt2000001.json`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().meta.id).toBe('tt2000001');
        await app.close();
      });

      it('enriches from Kinopoisk on the first request, then serves from cache without refetching', async () => {
        vi.spyOn(config, 'kinopoiskApiKey', 'get').mockReturnValue('mock-key');
        const fetchSpy = mockKinopoiskFetch();
        global.fetch = fetchSpy;

        await seedMappedTitle({
          nameRu: 'Enriched Show',
          hash: 'h1',
          imdbId: 'tt2000002',
          season: 1,
          episode: 1,
        });
        const app = build();
        const url = `/${config.addonToken}/meta/series/tt2000002.json`;

        const first = await app.inject({ method: 'GET', url });
        expect(first.statusCode).toBe(200);
        expect(first.json().meta).toMatchObject({
          description: 'Тестовое описание',
          genres: ['драма'],
          cast: ['Тестовый актёр'],
          poster: 'https://example.com/kp-poster.jpg',
        });
        const callsAfterFirst = fetchSpy.mock.calls.length;
        expect(callsAfterFirst).toBeGreaterThan(0);

        const second = await app.inject({ method: 'GET', url });
        expect(second.statusCode).toBe(200);
        expect(second.json().meta.description).toBe('Тестовое описание');
        expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);

        await app.close();
      });

      it('serves meta without enrichment (never a 500) when the Kinopoisk fetch fails', async () => {
        vi.spyOn(config, 'kinopoiskApiKey', 'get').mockReturnValue('mock-key');
        global.fetch = vi.fn().mockRejectedValue(new Error('network down'));

        await seedMappedTitle({
          nameRu: 'Unreachable Kinopoisk Show',
          hash: 'h1',
          imdbId: 'tt2000003',
          season: 1,
          episode: 1,
        });
        const app = build();
        const response = await app.inject({
          method: 'GET',
          url: `/${config.addonToken}/meta/series/tt2000003.json`,
        });
        expect(response.statusCode).toBe(200);
        const meta = response.json().meta;
        expect(meta.description).toBeUndefined();
        expect(meta.videos).toHaveLength(1);
        await app.close();
      });

      it('never attempts a Kinopoisk fetch for a title with no imdb_id', async () => {
        vi.spyOn(config, 'kinopoiskApiKey', 'get').mockReturnValue('mock-key');
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;

        const { titleId } = await seedMappedTitle({
          nameRu: 'No Imdb Show',
          hash: 'h1',
          tmdbId: 777,
          season: 1,
          episode: 1,
        });
        const app = build();
        const response = await app.inject({
          method: 'GET',
          url: `/${config.addonToken}/meta/series/torboxru:${titleId}.json`,
        });
        expect(response.statusCode).toBe(200);
        expect(fetchSpy).not.toHaveBeenCalled();
        await app.close();
      });

      it('resolves a tmdb:-shaped meta id the same as stream.ts does', async () => {
        await seedMappedTitle({
          nameRu: 'Tmdb Only Show',
          hash: 'h1',
          tmdbId: 888,
          season: 1,
          episode: 1,
        });
        const app = build();
        const response = await app.inject({
          method: 'GET',
          url: `/${config.addonToken}/meta/series/tmdb:888.json`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().meta.videos).toHaveLength(1);
        await app.close();
      });
    });

    it('404s (not 500) for a malformed uuid', async () => {
      const app = build();
      const response = await app.inject({
        method: 'GET',
        url: `/${config.addonToken}/meta/series/torboxru:not-a-uuid.json`,
      });
      expect(response.statusCode).toBe(404);
      await app.close();
    });

    it('404s for an unknown (but well-formed) title uuid', async () => {
      const app = build();
      const response = await app.inject({
        method: 'GET',
        url: `/${config.addonToken}/meta/series/torboxru:00000000-0000-0000-0000-000000000000.json`,
      });
      expect(response.statusCode).toBe(404);
      await app.close();
    });

    it('404s for a wrong token', async () => {
      const { titleId } = await seedMappedTitle({ nameRu: 'Show', hash: 'h1', tmdbId: 1 });
      const app = build();
      const response = await app.inject({
        method: 'GET',
        url: `/wrong-token/meta/series/torboxru:${titleId}.json`,
      });
      expect(response.statusCode).toBe(404);
      await app.close();
    });
  });

  it('round-trips: catalog card -> meta -> stream -> /play/:fileId', async () => {
    const { fileId } = await seedMappedTitle({
      nameRu: 'Round Trip Show',
      hash: 'h1',
      tmdbId: 999,
      season: 1,
      episode: 1,
    });
    const app = build();

    const catalogResponse = await app.inject({
      method: 'GET',
      url: `/${config.addonToken}/catalog/series/${CATALOG_ID}.json`,
    });
    const [card] = catalogResponse.json().metas;
    expect(card.id).toMatch(/^torboxru:/);

    const metaResponse = await app.inject({
      method: 'GET',
      url: `/${config.addonToken}/meta/series/${card.id}.json`,
    });
    const [video] = metaResponse.json().meta.videos;
    expect(video.id).toBe(`${card.id}:1:1`);

    const streamResponse = await app.inject({
      method: 'GET',
      url: `/${config.addonToken}/stream/series/${video.id}.json`,
    });
    expect(streamResponse.statusCode).toBe(200);
    const [stream] = streamResponse.json().streams;
    expect(stream.url).toBe(`${config.publicBase}/${config.addonToken}/play/${fileId}`);

    await app.close();
  });
});
