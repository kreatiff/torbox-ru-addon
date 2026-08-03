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

  return parsed.results.map((item) => {
    let year: number | null = null;
    if (item.first_air_date) {
      const parts = item.first_air_date.split('-');
      if (parts[0]) {
        const parsedYear = parseInt(parts[0], 10);
        if (!isNaN(parsedYear)) {
          year = parsedYear;
        }
      }
    }

    return {
      tmdbId: item.id,
      nameRu: item.name,
      nameEn: item.original_name ?? null,
      year,
      posterUrl: item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : null,
    };
  });
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
