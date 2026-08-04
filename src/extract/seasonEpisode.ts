import type { FileParseResult } from './types.js';

/**
 * Spec §3.5 cascade stage 1: explicit SxxExx with flexible separators.
 * Examples: s02e04, s02.E04, s02_e04, S02 E04.
 */
export function parseSeasonEpisode(input: string): FileParseResult | null {
  const match = input.match(/[sS](\d{1,2})[\s._-]*[eE](\d{1,3})/);
  if (!match) {
    return null;
  }

  const seasonStr = match[1];
  const episodeStr = match[2];
  if (seasonStr === undefined || episodeStr === undefined) {
    return null;
  }

  return {
    season: parseInt(seasonStr, 10),
    episode: parseInt(episodeStr, 10),
    absoluteHint: null,
    airDate: null,
    stage: 'seasonEpisode',
  };
}
