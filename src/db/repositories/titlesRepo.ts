import { normalise } from '../../normalize/normalise.js';
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
  posterUrl: string | null;
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
    posterUrl: row.poster_url ?? null,
  };
}

/**
 * Read-only lookups for the addon's stream route (Milestone 3): resolve the
 * id in a Stremio/AIOStreams stream request to our internal title id.
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

export async function getTitleById(id: string): Promise<Title | null> {
  const result = await pool.query('select * from titles where id = $1', [id]);
  const row = result.rows[0];
  return row ? toTitle(titleRowSchema.parse(row)) : null;
}

/**
 * Normalised lookup against existing titles (name + aliases) -- normalise()
 * folds Cyrillic/Latin homoglyphs and ё/е, so this catches matches a raw
 * case-insensitive comparison would miss (mixed-script or ё/е variants of
 * the same torrent-derived name). Returns null if the match is ambiguous
 * (more than one title with the same normalised name).
 *
 * Fetches every title rather than prefiltering in SQL: a prefilter on the
 * *raw* string (e.g. `lower(name_ru) = lower($1)`) would exclude exactly
 * the rows this function exists to catch -- a title whose raw name differs
 * from cleanedName only by a homoglyph or ё/е never matches the raw
 * prefilter, so it would never reach the normalise() comparison below at
 * all. A full scan is the same "table is small" tradeoff listAll() already
 * makes for the feed matcher.
 */
export async function findTitleByCleanedName(cleanedName: string): Promise<Title | null> {
  const target = normalise(cleanedName);
  const result = await pool.query('select * from titles');
  const matches = result.rows
    .map((row) => toTitle(titleRowSchema.parse(row)))
    .filter(
      (t) =>
        normalise(t.nameRu) === target ||
        (t.nameEn && normalise(t.nameEn) === target) ||
        t.aliases.some((a) => normalise(a) === target),
    );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** Every title in the library -- used by the feed scraper to match against
 * (docs/rutracker-scraper-plan.md), a cheap read given the table is small. */
export async function listAll(): Promise<Title[]> {
  const result = await pool.query('select * from titles order by name_ru');
  return result.rows.map((row) => toTitle(titleRowSchema.parse(row)));
}

export async function findOrCreateTitle(
  titleData: Omit<Title, 'id'>,
): Promise<Title> {
  // Try TMDB lookup
  if (titleData.tmdbId) {
    const existing = await findByTmdbId(titleData.tmdbId);
    if (existing) return existing;
  }
  // Try TVDB lookup
  if (titleData.tvdbId) {
    const result = await pool.query('select * from titles where tvdb_id = $1', [titleData.tvdbId]);
    const row = result.rows[0];
    if (row) return toTitle(titleRowSchema.parse(row));
  }
  // Try IMDb lookup
  if (titleData.imdbId) {
    const existing = await findByImdbId(titleData.imdbId);
    if (existing) return existing;
  }

  // Otherwise, create new
  const result = await pool.query(
    `insert into titles (imdb_id, tvdb_id, tmdb_id, name_ru, name_en, year, aliases, poster_url)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning *`,
    [
      titleData.imdbId,
      titleData.tvdbId,
      titleData.tmdbId,
      titleData.nameRu,
      titleData.nameEn,
      titleData.year,
      titleData.aliases,
      titleData.posterUrl,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to create title');
  }
  return toTitle(titleRowSchema.parse(row));
}

const TITLE_UPDATE_COLUMNS: Record<string, string> = {
  imdbId: 'imdb_id',
  tvdbId: 'tvdb_id',
  tmdbId: 'tmdb_id',
  nameRu: 'name_ru',
  nameEn: 'name_en',
  year: 'year',
  posterUrl: 'poster_url',
};

/**
 * Partial update for manual corrections from the Library UI (e.g. fixing a
 * wrong TMDB match, or filling in an id the auto-resolver couldn't find) --
 * only the keys present in `patch` are touched, so `{}` is a no-op read.
 * Unique-constraint conflicts (another title already owns the imdb/tvdb/tmdb
 * id being set) surface as the raw pg error; callers use db/errors.ts'
 * toConflictError to turn that into a clean 409.
 */
export type TitlePatch = { [K in keyof Omit<Title, 'id' | 'aliases'>]?: Title[K] | undefined };

export async function updateTitle(id: string, patch: TitlePatch): Promise<Title | null> {
  const entries = Object.entries(patch).filter(
    ([key, value]) => key in TITLE_UPDATE_COLUMNS && value !== undefined,
  );
  if (entries.length === 0) {
    return getTitleById(id);
  }

  const setClauses = entries.map(([key], idx) => `${TITLE_UPDATE_COLUMNS[key]} = $${idx + 2}`);
  const values = entries.map(([, value]) => value);

  const result = await pool.query(
    `update titles set ${setClauses.join(', ')} where id = $1 returning *`,
    [id, ...values],
  );
  const row = result.rows[0];
  return row ? toTitle(titleRowSchema.parse(row)) : null;
}

export interface TitleWithSeasons extends Title {
  seasons: {
    seasonNumber: number;
    mappedEpisodesCount: number;
    totalEpisodesCount: number | null;
  }[];
}

export async function listTitlesWithSeasons(): Promise<TitleWithSeasons[]> {
  const titlesResult = await pool.query('select * from titles order by name_ru');
  const titles = titlesResult.rows.map((row) => toTitle(titleRowSchema.parse(row)));

  const result: TitleWithSeasons[] = [];
  for (const t of titles) {
    const seasonsResult = await pool.query(
      `select m.season, count(distinct m.episode) as mapped_count
       from mappings m
       where m.title_id = $1
       group by m.season
       order by m.season`,
      [t.id]
    );

    const seasons = await Promise.all(
      seasonsResult.rows.map(async (row) => {
        const seasonNumber = parseInt(row.season, 10);
        const mappedEpisodesCount = parseInt(row.mapped_count, 10);

        // Fetch from provider_seasons cache if available
        const providerSeasonResult = await pool.query(
          `select episode_count from provider_seasons
           where title_id = $1 and season = $2
           limit 1`,
          [t.id, seasonNumber]
        );
        const providerRow = providerSeasonResult.rows[0];
        const totalEpisodesCount = providerRow ? parseInt(providerRow.episode_count, 10) : null;

        return {
          seasonNumber,
          mappedEpisodesCount,
          totalEpisodesCount,
        };
      })
    );

    result.push({
      ...t,
      seasons,
    });
  }

  return result;
}
