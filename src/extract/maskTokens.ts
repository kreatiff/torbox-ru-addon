import type { AirDateResult, MaskResult } from './types.js';
import { airDateRegex } from './airDate.js';
import { buildQualityCodecRegex, buildReleaseGroupRegex, type MaskConfig } from './qualityCodecTokens.js';

/**
 * Spec §3.2 ordered masking pipeline. Runs BEFORE any number extraction.
 * Returns the masked string plus any tokens that downstream stages need
 * (air dates and SxxExx markers). The input is expected to already be
 * normalised (Cyrillic→Latin fold, lowercase).
 *
 * Order is load-bearing:
 *   1. Air dates — must happen before years so DD.MM.YYYY isn't partially matched.
 *   2. Years like (2026).
 *   3. Quality/codec tokens (1080p, HDTV, x265, ...).
 *   4. Release groups (by.Nicodem, Files-x, ...).
 *   5. Season/episode markers — captured, then masked.
 * After this, the cascade looks for bare numbers on the masked string.
 */
export function maskTokens(input: string, config?: MaskConfig): MaskResult {
  let masked = input;
  const airDates: AirDateResult[] = [];
  let seasonEpisode: { season: number; episode: number; raw: string } | null = null;

  // 1. Air dates: "Эфир от DD.MM.YYYY"
  masked = masked.replace(airDateRegex, (raw, day, month, year) => {
    const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    airDates.push({ date, raw });
    return '__AIR_DATE__';
  });

  // 2. Years: (19|20)XX with optional surrounding parentheses.
  masked = masked.replace(/\(?\b(?:19|20)\d{2}\b\)?/g, '__YEAR__');

  // 3. Quality/codec tokens.
  masked = masked.replace(buildQualityCodecRegex(config), '__QUALITY__');

  // 4. Release groups.
  masked = masked.replace(buildReleaseGroupRegex(config), '__RELEASE__');

  // 5. Season/episode markers: SxxExx with flexible separators.
  masked = masked.replace(
    /[sS](\d{1,2})[\s._-]*[eE](\d{1,3})/g,
    (raw, seasonStr, episodeStr) => {
      seasonEpisode = {
        season: parseInt(seasonStr, 10),
        episode: parseInt(episodeStr, 10),
        raw,
      };
      return '__SEASON_EPISODE__';
    },
  );

  return { masked, airDate: airDates[0] ?? null, seasonEpisode };
}
