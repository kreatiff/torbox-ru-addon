import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';

const KINOPOISK_BASE_URL = 'https://kinopoiskapiunofficial.tech';

// The two unofficial Kinopoisk APIs (kinopoisk.dev, kinopoiskapiunofficial.tech)
// have different response shapes; this client targets kinopoiskapiunofficial.tech
// specifically -- see docs/decisions.md for why (matches the key the repo owner
// already has, not an architectural constraint).

const kinopoiskSearchItemSchema = z.object({
  kinopoiskId: z.number().int(),
});

const kinopoiskSearchByImdbResponseSchema = z.object({
  items: z.array(kinopoiskSearchItemSchema),
});

const kinopoiskFilmDetailSchema = z.object({
  description: z.string().nullable().optional(),
  posterUrl: z.string().nullable().optional(),
  genres: z.array(z.object({ genre: z.string() })).optional(),
});

const kinopoiskStaffItemSchema = z.object({
  nameRu: z.string().nullable().optional(),
  nameEn: z.string().nullable().optional(),
  professionKey: z.string(),
});

const kinopoiskStaffResponseSchema = z.array(kinopoiskStaffItemSchema);

export interface KinopoiskFilmDetails {
  description: string | null;
  posterUrl: string | null;
  genres: string[];
}

export interface KinopoiskMetadata {
  kinopoiskId: number;
  description: string | null;
  posterUrl: string | null;
  genres: string[];
  cast: string[];
}

/** How many actors to keep from the staff list -- Stremio's `cast` field is
 * a flat name list, not a full credits page; the top few leads are what a
 * detail view actually shows. */
const CAST_LIMIT = 5;

async function kinopoiskFetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const key = config.kinopoiskApiKey;
  if (!key) {
    throw new Error('KINOPOISK_API_KEY is not configured');
  }

  const query = new URLSearchParams(params).toString();
  const url = `${KINOPOISK_BASE_URL}${path}${query ? `?${query}` : ''}`;
  const response = await fetch(url, { headers: { 'X-API-KEY': key, Accept: 'application/json' } });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    const text = await response.text();
    logger.error({ path, status: response.status, body: text }, 'Kinopoisk API request failed');
    throw new Error(`Kinopoisk API returned HTTP ${response.status}: ${text}`);
  }

  try {
    return await response.json();
  } catch {
    logger.error({ path, status: response.status }, 'Kinopoisk API response was not valid JSON');
    throw new Error(`Kinopoisk API returned non-JSON response (HTTP ${response.status})`);
  }
}

/** Resolves an IMDb id to a Kinopoisk film id via the by-imdbId search --
 * the only reliable cross-reference this client uses (no keyword/fuzzy
 * matching, to avoid mismatching a title to the wrong Kinopoisk entry). */
export async function findKinopoiskIdByImdbId(imdbId: string): Promise<number | null> {
  const data = await kinopoiskFetch('/api/v2.2/films', { imdbId });
  if (!data) return null;
  const parsed = kinopoiskSearchByImdbResponseSchema.parse(data);
  return parsed.items[0]?.kinopoiskId ?? null;
}

export async function fetchFilmDetails(kinopoiskId: number): Promise<KinopoiskFilmDetails | null> {
  const data = await kinopoiskFetch(`/api/v2.2/films/${kinopoiskId}`);
  if (!data) return null;
  const parsed = kinopoiskFilmDetailSchema.parse(data);
  return {
    description: parsed.description ?? null,
    posterUrl: parsed.posterUrl ?? null,
    genres: (parsed.genres ?? []).map((g) => g.genre),
  };
}

export async function fetchCast(kinopoiskId: number): Promise<string[]> {
  const data = await kinopoiskFetch('/api/v1/staff', { filmId: String(kinopoiskId) });
  if (!data) return [];
  const parsed = kinopoiskStaffResponseSchema.parse(data);
  return parsed
    .filter((person) => person.professionKey === 'ACTOR')
    .slice(0, CAST_LIMIT)
    .map((person) => person.nameRu || person.nameEn)
    .filter((name): name is string => !!name);
}

/**
 * Full Kinopoisk enrichment for one title, given its imdb_id -- the addon's
 * `meta` route (issue #28) calls this on a cache miss and persists the
 * result via titlesRepo.setKinopoiskMetadata. Soft-fails (returns null) only
 * when KINOPOISK_API_KEY is unset or no Kinopoisk film matches the imdb id
 * at all -- mirrors src/metadata/tmdb.ts's shape exactly. A real HTTP/parse
 * error from kinopoiskFetch propagates (thrown), same as tmdb.ts; the
 * caller in meta.ts wraps this in a try/catch so a Kinopoisk outage never
 * breaks serving the rest of the meta response.
 */
export async function fetchKinopoiskMetadata(imdbId: string): Promise<KinopoiskMetadata | null> {
  if (!config.kinopoiskApiKey) {
    logger.warn('KINOPOISK_API_KEY not configured. Skipping Kinopoisk metadata lookup.');
    return null;
  }

  const kinopoiskId = await findKinopoiskIdByImdbId(imdbId);
  if (!kinopoiskId) {
    return null;
  }

  const [details, cast] = await Promise.all([
    fetchFilmDetails(kinopoiskId),
    fetchCast(kinopoiskId),
  ]);

  return {
    kinopoiskId,
    description: details?.description ?? null,
    posterUrl: details?.posterUrl ?? null,
    genres: details?.genres ?? [],
    cast,
  };
}
