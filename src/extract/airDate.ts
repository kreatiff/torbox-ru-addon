import { normalise } from '../normalize/normalise.js';
import type { AirDateResult } from './types.js';

// The pattern is generated from the normalised form because the extractor
// receives normalised input. "Эфир от" folds to "эфиp oт" (Cyrillic р, о, т
// become Latin p, o, t under the confusables table).
const airDatePrefix = normalise('Эфир от');
const escapedPrefix = airDatePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex matching the normalised air-date prefix. */
export const airDateRegex = new RegExp(
  `${escapedPrefix}\\s*(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})`,
  'i',
);

/**
 * Spec §3.2 stage 1: extract "Эфир от DD.MM.YYYY" and normalise it to
 * YYYY-MM-DD for lookup against provider_seasons.episodes air dates.
 */
export function parseAirDate(input: string): AirDateResult | null {
  const match = input.match(airDateRegex);
  if (!match) {
    return null;
  }

  const day = match[1];
  const month = match[2];
  const year = match[3];
  if (day === undefined || month === undefined || year === undefined) {
    return null;
  }

  return {
    date: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
    raw: match[0],
  };
}

/** Find the first air date in a string. */
export function findAirDate(input: string): AirDateResult | null {
  return parseAirDate(input);
}
