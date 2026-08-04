import type { FileParseResult } from './types.js';
import { buildNumberWordRegex } from './vocabulary.js';

/**
 * Spec §3.5 cascade stage 2: number + episode word or episode word + number.
 * Examples: "01 выпуск", "выпуск 01", "01.выпуск", "выпуск.01".
 */
export function parseEpisodeNumber(input: string): FileParseResult | null {
  const regex = buildNumberWordRegex();
  const match = input.match(regex);
  if (!match) {
    return null;
  }

  const episodeStr = match[1] ?? match[2];
  if (episodeStr === undefined) {
    return null;
  }
  const episode = parseInt(episodeStr, 10);
  if (Number.isNaN(episode)) {
    return null;
  }

  return {
    season: null,
    episode,
    absoluteHint: null,
    airDate: null,
    stage: 'episodeNumber',
  };
}
