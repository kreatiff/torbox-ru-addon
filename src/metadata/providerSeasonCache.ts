import { getProviderSeason, upsertProviderSeason } from '../db/repositories/providerSeasonsRepo.js';
import type { ProviderSeasonRow } from '../db/schema.types.js';
import { fetchSeasonDetails } from './tmdb.js';
import { logger } from '../logger.js';

// A season still airing gains a new episode every week or so -- 24h keeps a
// cache entry from going stale for long even when nothing forces an earlier
// refresh via requiredEpisodes below.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function coversEpisodes(row: ProviderSeasonRow, requiredEpisodes: number[]): boolean {
  if (requiredEpisodes.length === 0) {
    return true;
  }
  const known = new Set(row.episodes.map((e) => e.episode));
  return requiredEpisodes.every((ep) => known.has(ep));
}

function isStale(row: ProviderSeasonRow): boolean {
  return Date.now() - row.fetched_at.getTime() > CACHE_TTL_MS;
}

/**
 * Cached TMDB season lookup that self-heals instead of caching forever.
 * `provider_seasons` used to be fetched once and trusted for the table's
 * whole life (§5.4: "cache aggressively... these change rarely") -- true for
 * a finished season, false for one still airing. Under the old behaviour, a
 * season cached while only episodes 1-10 existed would reject episode 11
 * forever: proposeRule's episodesWithinProvider gate checks the LLM's
 * episode number against exactly this cache, and a rejection queues the
 * torrent for manual review with no mapping (and no way for a plain
 * re-ingest to ever fix it, since the cache never changed).
 *
 * A cache hit now requires BOTH that every episode in `requiredEpisodes` is
 * already present in the cached row AND that the row isn't older than
 * CACHE_TTL_MS; either miss triggers a live re-fetch. A re-fetch that fails
 * or comes back empty falls back to the stale cached row (if any) rather
 * than losing known data -- same "best-effort, never block on it" posture
 * as the rest of this file's callers.
 */
export async function getOrRefreshProviderSeason(
  titleId: string,
  tmdbId: number | null,
  season: number,
  requiredEpisodes: number[] = [],
): Promise<ProviderSeasonRow | null> {
  const cached = await getProviderSeason(titleId, season, 'tmdb');
  if (cached && coversEpisodes(cached, requiredEpisodes) && !isStale(cached)) {
    return cached;
  }
  if (!tmdbId) {
    return cached;
  }

  try {
    const episodes = await fetchSeasonDetails(tmdbId, season);
    if (episodes.length === 0) {
      return cached;
    }
    return await upsertProviderSeason({
      title_id: titleId,
      season,
      source: 'tmdb',
      episode_count: episodes.length,
      episodes,
    });
  } catch (err) {
    logger.warn(
      { err, titleId, tmdbId, season },
      'Failed to refresh TMDB season cache; falling back to previously cached data',
    );
    return cached;
  }
}
