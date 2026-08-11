import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';

const TMDB_BASE_URL = 'https://api.themoviedb.org';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

const tmdbSearchResultSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  original_name: z.string().optional().nullable(),
  first_air_date: z.string().optional().nullable(),
  poster_path: z.string().optional().nullable(),
});

const tmdbSearchResponseSchema = z.object({
  results: z.array(tmdbSearchResultSchema),
});

const tmdbFindResponseSchema = z.object({
  tv_results: z.array(tmdbSearchResultSchema),
});

const tmdbEpisodeSchema = z.object({
  episode_number: z.number().int(),
  air_date: z.string().optional().nullable(),
  name: z.string().optional().nullable(),
});

const tmdbSeasonResponseSchema = z.object({
  episodes: z.array(tmdbEpisodeSchema),
});

const tmdbExternalIdsSchema = z.object({
  imdb_id: z.string().optional().nullable(),
  tvdb_id: z.number().int().optional().nullable(),
});

export interface TmdbSearchResult {
  tmdbId: number;
  nameRu: string;
  nameEn: string | null;
  year: number | null;
  posterUrl: string | null;
}

export interface TmdbEpisode {
  episode: number;
  air_date: string | null;
}

export interface ResolvedTitleIds {
  tmdbId: number | null;
  imdbId: string | null;
  tvdbId: number | null;
  nameRu: string | null;
  nameEn: string | null;
  year: number | null;
  posterUrl: string | null;
}

function yearFromAirDate(airDate: string | null | undefined): number | null {
  if (!airDate) return null;
  const parsedYear = parseInt(airDate.split('-')[0] ?? '', 10);
  return isNaN(parsedYear) ? null : parsedYear;
}

function toSearchResult(item: z.infer<typeof tmdbSearchResultSchema>): TmdbSearchResult {
  return {
    tmdbId: item.id,
    nameRu: item.name,
    nameEn: item.original_name ?? null,
    year: yearFromAirDate(item.first_air_date),
    posterUrl: item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : null,
  };
}

function getAuthHeadersAndParams(
  path: string,
  params: Record<string, string>,
): { headers: Record<string, string>; url: string } {
  const key = config.tmdbApiKey;
  if (!key) {
    throw new Error('TMDB_API_KEY is not configured');
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  const urlParams = new URLSearchParams(params);

  // Check if key is a v4 JWT token (Standard Bearer token is very long and contains dots)
  if (key.length > 50 || key.includes('.')) {
    headers['Authorization'] = `Bearer ${key}`;
  } else {
    urlParams.set('api_key', key);
  }

  const url = `${TMDB_BASE_URL}/3${path}?${urlParams.toString()}`;
  return { headers, url };
}

async function tmdbFetch(
  path: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const { headers, url } = getAuthHeadersAndParams(path, params);
  const response = await fetch(url, { headers });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    const text = await response.text();
    logger.error({ path, status: response.status, body: text }, 'TMDB API request failed');
    throw new Error(`TMDB API returned HTTP ${response.status}: ${text}`);
  }

  try {
    return await response.json();
  } catch {
    logger.error({ path, status: response.status }, 'TMDB API response was not valid JSON');
    throw new Error(`TMDB API returned non-JSON response (HTTP ${response.status})`);
  }
}

export async function searchTitles(query: string): Promise<TmdbSearchResult[]> {
  if (!config.tmdbApiKey) {
    logger.warn('TMDB_API_KEY not configured. Skipping TMDB search lookup.');
    return [];
  }

  const data = await tmdbFetch('/search/tv', {
    query,
    language: 'ru-RU',
  });

  if (!data) return [];
  const parsed = tmdbSearchResponseSchema.parse(data);

  return parsed.results.map(toSearchResult);
}

/**
 * Cross-reference lookup: given an IMDb or TVDB id, finds the matching TMDB
 * TV entry via TMDB's /find endpoint (this is what lets a human "manually
 * add" a title by pasting just an IMDb/TVDB id -- TMDB acts as the hub that
 * resolves it to everything else, see resolveTitleIds below).
 */
export async function findByExternalId(
  source: 'imdb_id' | 'tvdb_id',
  externalId: string | number,
): Promise<TmdbSearchResult | null> {
  if (!config.tmdbApiKey) {
    logger.warn('TMDB_API_KEY not configured. Skipping TMDB external id lookup.');
    return null;
  }

  const data = await tmdbFetch(`/find/${externalId}`, {
    external_source: source,
    language: 'ru-RU',
  });

  if (!data) return null;
  const parsed = tmdbFindResponseSchema.parse(data);
  const match = parsed.tv_results[0];
  return match ? toSearchResult(match) : null;
}

/** Basic show info (name/year/poster) for a TMDB id already in hand -- used
 * by resolveTitleIds when a human enters a TMDB id directly, without going
 * through search or an external-id cross-reference first. */
export async function fetchTvDetails(tmdbId: number): Promise<TmdbSearchResult | null> {
  if (!config.tmdbApiKey) {
    logger.warn('TMDB_API_KEY not configured. Skipping TMDB details lookup.');
    return null;
  }

  const data = await tmdbFetch(`/tv/${tmdbId}`, { language: 'ru-RU' });
  if (!data) return null;
  const parsed = tmdbSearchResultSchema.parse(data);
  return toSearchResult(parsed);
}

export async function fetchExternalIds(
  tmdbId: number,
): Promise<{ imdbId: string | null; tvdbId: number | null }> {
  const data = await tmdbFetch(`/tv/${tmdbId}/external_ids`);
  if (!data) {
    return { imdbId: null, tvdbId: null };
  }
  const parsed = tmdbExternalIdsSchema.parse(data);
  return {
    imdbId: parsed.imdb_id || null,
    tvdbId: parsed.tvdb_id || null,
  };
}

export async function fetchSeasonDetails(
  tmdbId: number,
  seasonNumber: number,
): Promise<TmdbEpisode[]> {
  const data = await tmdbFetch(`/tv/${tmdbId}/season/${seasonNumber}`, {
    language: 'ru-RU',
  });

  if (!data) {
    return [];
  }

  const parsed = tmdbSeasonResponseSchema.parse(data);
  return parsed.episodes.map((ep) => ({
    episode: ep.episode_number,
    air_date: ep.air_date || null,
  }));
}

/**
 * Reliable multi-service id matching, in one call: given any one (or more)
 * of tmdbId/imdbId/tvdbId, cross-references TMDB to fill in the others plus
 * a name/year/poster preview -- so a title only needs one correct id to end
 * up with all three. TMDB is the hub for this because it's the only one of
 * the three with a free, keyless-beyond-our-existing-key cross-reference
 * endpoint (/find); a bare imdbId or tvdbId with no TMDB match still comes
 * back with just that one id and null everything else, which is a valid
 * (if less reliable) title to save.
 *
 * Ids explicitly passed in are never overwritten by a discovery lookup --
 * only null/missing ones get backfilled -- so a human's manual correction
 * always wins over whatever TMDB's cross-reference happens to return.
 */
export async function resolveTitleIds(input: {
  tmdbId?: number | null;
  imdbId?: string | null;
  tvdbId?: number | null;
}): Promise<ResolvedTitleIds> {
  let tmdbId = input.tmdbId ?? null;
  let imdbId = input.imdbId ?? null;
  let tvdbId = input.tvdbId ?? null;
  let match: TmdbSearchResult | null = null;

  if (!config.tmdbApiKey) {
    return { tmdbId, imdbId, tvdbId, nameRu: null, nameEn: null, year: null, posterUrl: null };
  }

  if (!tmdbId && imdbId) {
    match = await findByExternalId('imdb_id', imdbId);
    if (match) tmdbId = match.tmdbId;
  }
  if (!tmdbId && tvdbId) {
    match = await findByExternalId('tvdb_id', tvdbId);
    if (match) tmdbId = match.tmdbId;
  }

  if (tmdbId) {
    const [external, details] = await Promise.all([
      fetchExternalIds(tmdbId),
      match ? Promise.resolve(match) : fetchTvDetails(tmdbId),
    ]);
    imdbId = imdbId || external.imdbId;
    tvdbId = tvdbId || external.tvdbId;
    match = details;
  }

  return {
    tmdbId,
    imdbId,
    tvdbId,
    nameRu: match?.nameRu ?? null,
    nameEn: match?.nameEn ?? null,
    year: match?.year ?? null,
    posterUrl: match?.posterUrl ?? null,
  };
}
