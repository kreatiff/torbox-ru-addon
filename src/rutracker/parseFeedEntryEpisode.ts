import { parseTorrent, parseEpisodeSource } from '../extract/cascade.js';
import { normalise } from '../normalize/normalise.js';

export interface FeedEntrySeasonEpisode {
  season: number | null;
  episode: number | null;
}

/**
 * Best-effort season/episode extraction from a feed entry's raw title, for
 * the "already in library" check on the Feed tab. Reuses the same
 * extractor cascade a single-file torrent goes through (`cascade()` in
 * extract/cascade.ts treats a lone video file's torrent name exactly this
 * way) rather than duplicating season/episode-number parsing here -- a feed
 * entry's rawTitle is the same string shape as `torrents.raw_name_at_ingest`.
 *
 * Verified against real feed data: "5 выпуск" -> 5, "3 выпуск из 9" -> 3,
 * "серии 54 из 59" -> 54.
 */
export function parseFeedEntrySeasonEpisode(rawTitle: string): FeedEntrySeasonEpisode {
  const torrentParse = parseTorrent(rawTitle);
  const source = normalise(rawTitle);
  const parsed = parseEpisodeSource(source, torrentParse);
  return { season: torrentParse.season, episode: parsed.episode };
}
