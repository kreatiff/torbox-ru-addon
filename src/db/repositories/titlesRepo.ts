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
 * Read-only lookup for the addon's stream route (Milestone 3): resolves the
 * `tt...` id in a Stremio stream request to our internal title id.
 * `findOrCreate` (writing new title rows from the Labeller UI's show picker)
 * is Milestone 4 scope and deliberately not built here.
 */
export async function findByImdbId(imdbId: string): Promise<Title | null> {
  const result = await pool.query('select * from titles where imdb_id = $1', [imdbId]);
  const row = result.rows[0];
  return row ? toTitle(titleRowSchema.parse(row)) : null;
}
