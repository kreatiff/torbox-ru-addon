import { pool } from '../pool.js';
import { titleRowSchema, type TitleRow } from '../schema.types.js';

export interface Title {
  id: string;
  imdbId: string | null;
  tvdbId: number | null;
  tmdbId: number | null;
  nameRu: string;
  nameEn: string | null;
  year: number | null;
  aliases: string[];
}

function toTitle(row: TitleRow): Title {
  return {
    id: row.id,
    imdbId: row.imdb_id,
    tvdbId: row.tvdb_id,
    tmdbId: row.tmdb_id,
    nameRu: row.name_ru,
    nameEn: row.name_en,
    year: row.year,
    aliases: row.aliases,
  };
}

/**
 * Read-only lookups for the addon's stream route (Milestone 3): resolve the
 * id in a Stremio/AIOStreams stream request to our internal title id.
 * Real-world clients don't only send `tt...` ids -- AIOStreams in
 * particular resolves some titles via TMDB instead (`tmdb:250793:...`),
 * found verifying this against a real account, hence both lookups.
 * `findOrCreate` (writing new title rows from the Labeller UI's show picker)
 * is Milestone 4 scope and deliberately not built here.
 */
export async function findByImdbId(imdbId: string): Promise<Title | null> {
  const result = await pool.query('select * from titles where imdb_id = $1', [imdbId]);
  const row = result.rows[0];
  return row ? toTitle(titleRowSchema.parse(row)) : null;
}

export async function findByTmdbId(tmdbId: number): Promise<Title | null> {
  const result = await pool.query('select * from titles where tmdb_id = $1', [tmdbId]);
  const row = result.rows[0];
  return row ? toTitle(titleRowSchema.parse(row)) : null;
}
