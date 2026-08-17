import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { hasTestDb, truncateAll } from '../testDb.js';
import { pool } from '../../../src/db/pool.js';
import {
  getTitleById,
  updateTitle,
  findTitleByCleanedName,
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
      const inserted = await pool.query(`insert into titles (name_ru) values ('Show') returning id`);
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
      const inserted = await pool.query(`insert into titles (name_ru) values ('Mine') returning id`);
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
});
