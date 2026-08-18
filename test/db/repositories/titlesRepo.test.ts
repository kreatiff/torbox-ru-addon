import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { hasTestDb, truncateAll } from '../testDb.js';
import { pool } from '../../../src/db/pool.js';
import {
  getTitleById,
  updateTitle,
  findTitleByCleanedName,
  listMappedTitles,
  setKinopoiskMetadata,
} from '../../../src/db/repositories/titlesRepo.js';

describe.skipIf(!hasTestDb)('titlesRepo', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('getTitleById', () => {
    it('reads a title back by id', async () => {
      const inserted = await pool.query(
        `insert into titles (name_ru, tmdb_id) values ('Тестовое шоу', 42) returning id`,
      );
      const title = await getTitleById(inserted.rows[0].id);
      expect(title?.nameRu).toBe('Тестовое шоу');
      expect(title?.tmdbId).toBe(42);
    });

    it('returns null for a missing id', async () => {
      const title = await getTitleById('00000000-0000-0000-0000-000000000000');
      expect(title).toBeNull();
    });
  });

  describe('updateTitle', () => {
    it('updates only the fields present in the patch', async () => {
      const inserted = await pool.query(
        `insert into titles (name_ru, name_en, year) values ('Old', 'Old EN', 2019) returning id`,
      );
      const id = inserted.rows[0].id as string;

      const updated = await updateTitle(id, { imdbId: 'tt1234567' });
      expect(updated).toEqual(
        expect.objectContaining({
          id,
          nameRu: 'Old',
          nameEn: 'Old EN',
          year: 2019,
          imdbId: 'tt1234567',
          tvdbId: null,
          tmdbId: null,
        }),
      );
    });

    it('is a no-op read for an empty patch', async () => {
      const inserted = await pool.query(
        `insert into titles (name_ru) values ('Show') returning id`,
      );
      const id = inserted.rows[0].id as string;

      const result = await updateTitle(id, {});
      expect(result?.nameRu).toBe('Show');
    });

    it('ignores explicit undefined values in the patch (JSON body omitted the key)', async () => {
      const inserted = await pool.query(
        `insert into titles (name_ru, imdb_id) values ('Show', 'tt1111111') returning id`,
      );
      const id = inserted.rows[0].id as string;

      const result = await updateTitle(id, { imdbId: undefined, year: 2022 });
      expect(result?.imdbId).toBe('tt1111111');
      expect(result?.year).toBe(2022);
    });

    it('returns null for a missing title id', async () => {
      const result = await updateTitle('00000000-0000-0000-0000-000000000000', { year: 2020 });
      expect(result).toBeNull();
    });

    it('rejects a tmdbId that already belongs to another title (unique_violation)', async () => {
      await pool.query(`insert into titles (name_ru, tmdb_id) values ('Other', 42)`);
      const inserted = await pool.query(
        `insert into titles (name_ru) values ('Mine') returning id`,
      );
      const id = inserted.rows[0].id as string;

      await expect(updateTitle(id, { tmdbId: 42 })).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('findTitleByCleanedName', () => {
    it('finds an exact (case-insensitive) match on name_ru', async () => {
      const inserted = await pool.query(
        `insert into titles (name_ru) values ('Большой куш') returning id`,
      );
      const found = await findTitleByCleanedName('большой куш');
      expect(found?.id).toBe(inserted.rows[0].id);
    });

    it('finds a match that only differs by ё/е -- normalised, not raw, comparison', async () => {
      // The SQL prefilter used to compare the raw strings
      // (`lower(name_ru) = lower($1)`), which never matches when the only
      // difference is ё vs е -- normalise() folds that, but a row that
      // differs only this way never survived the raw-string SQL filter to
      // reach the JS-side normalise() comparison at all.
      const inserted = await pool.query(
        `insert into titles (name_ru) values ('Ёжик в тумане') returning id`,
      );
      const found = await findTitleByCleanedName('Ежик в тумане');
      expect(found?.id).toBe(inserted.rows[0].id);
    });

    it('finds a match via an alias, normalised', async () => {
      const inserted = await pool.query(
        `insert into titles (name_ru, aliases) values ('Show', array['Ёлки']) returning id`,
      );
      const found = await findTitleByCleanedName('Елки');
      expect(found?.id).toBe(inserted.rows[0].id);
    });

    it('returns null (not an arbitrary pick) when the normalised name is ambiguous', async () => {
      // Two distinct titles that both normalise to the same target -- the
      // docstring promises null here; the old implementation returned
      // matches[0] unconditionally instead.
      await pool.query(`insert into titles (name_ru) values ('Ёжик')`);
      await pool.query(`insert into titles (name_ru) values ('ежик')`);

      const found = await findTitleByCleanedName('Ежик');
      expect(found).toBeNull();
    });

    it('returns null when nothing matches', async () => {
      await pool.query(`insert into titles (name_ru) values ('Совсем другое шоу')`);
      const found = await findTitleByCleanedName('Несуществующее шоу');
      expect(found).toBeNull();
    });
  });

  describe('listMappedTitles', () => {
    async function seedMappedTitle(nameRu: string, hash: string): Promise<string> {
      const title = await pool.query(`insert into titles (name_ru) values ($1) returning id`, [
        nameRu,
      ]);
      const titleId = title.rows[0].id as string;
      await pool.query(
        `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
         values ($1, 1, 'Torrent', now())`,
        [hash],
      );
      const rule = await pool.query(
        `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source)
         values ($1, $2, 1, 'sequential', 'natural', 1, 1.0, 'manual') returning id`,
        [hash, titleId],
      );
      const file = await pool.query(
        `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
         values ($1, 1, 'a.mp4', 1, true) returning id`,
        [hash],
      );
      await pool.query(
        `insert into mappings (file_id, title_id, season, episode, rule_id) values ($1, $2, 1, 1, $3)`,
        [file.rows[0].id, titleId, rule.rows[0].id],
      );
      return titleId;
    }

    it('returns only titles with at least one mapped file', async () => {
      const mappedId = await seedMappedTitle('Mapped Show', 'h1');
      await pool.query(`insert into titles (name_ru) values ('Unmapped Show')`);

      const titles = await listMappedTitles();
      expect(titles.map((t) => t.id)).toEqual([mappedId]);
    });

    it('orders by most recently mapped (rule.created_at) first', async () => {
      const olderId = await seedMappedTitle('Older Show', 'h1');
      // created_at defaults to now(); force a deterministic order.
      await pool.query(
        `update rules set created_at = now() - interval '1 day' where torrent_hash = 'h1'`,
      );
      const newerId = await seedMappedTitle('Newer Show', 'h2');

      const titles = await listMappedTitles();
      expect(titles.map((t) => t.id)).toEqual([newerId, olderId]);
    });

    it('reports lastMappedAt as null when the mapping rule has since been deleted', async () => {
      const titleId = await seedMappedTitle('Orphaned Mapping Show', 'h1');
      await pool.query(`update mappings set rule_id = null where title_id = $1`, [titleId]);

      const [title] = await listMappedTitles();
      expect(title?.lastMappedAt).toBeNull();
    });
  });

  describe('setKinopoiskMetadata', () => {
    it('persists a full Kinopoisk enrichment patch, readable back via getTitleById', async () => {
      const inserted = await pool.query(
        `insert into titles (name_ru) values ('Show') returning id`,
      );
      const titleId = inserted.rows[0].id as string;

      await setKinopoiskMetadata(titleId, {
        kinopoiskId: 326,
        description: 'Описание',
        posterUrl: 'https://example.com/poster.jpg',
        genres: ['драма'],
        cast: ['Тим Роббинс', 'Морган Фриман'],
      });

      const title = await getTitleById(titleId);
      expect(title).toMatchObject({
        kinopoiskId: 326,
        kinopoiskDescription: 'Описание',
        kinopoiskPosterUrl: 'https://example.com/poster.jpg',
        kinopoiskGenres: ['драма'],
        kinopoiskCast: ['Тим Роббинс', 'Морган Фриман'],
      });
      expect(title?.kinopoiskCheckedAt).toBeInstanceOf(Date);
    });

    it('persists a "checked, nothing found" patch -- checkedAt still gets set so the caller stops retrying', async () => {
      const inserted = await pool.query(
        `insert into titles (name_ru) values ('Show') returning id`,
      );
      const titleId = inserted.rows[0].id as string;

      await setKinopoiskMetadata(titleId, {
        kinopoiskId: null,
        description: null,
        posterUrl: null,
        genres: [],
        cast: [],
      });

      const title = await getTitleById(titleId);
      expect(title?.kinopoiskId).toBeNull();
      expect(title?.kinopoiskDescription).toBeNull();
      expect(title?.kinopoiskCheckedAt).toBeInstanceOf(Date);
    });
  });
});
