import { normalise } from '../normalize/normalise.js';
import type { XofYResult } from './types.js';

// Spec §3.4 LOCKED: X из Y is a completeness count, never an episode number.
// Supports the original Cyrillic "из", Latin "iz", and the "u3" alias.
// All patterns are generated from their normalised forms because the extractor
// receives normalised input.

const xOfYWords = ['из', 'iz', 'u3'].map(normalise);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const xOfYWordsPattern = xOfYWords.map(escapeRegex).join('|');

/**
 * Detects both the single form "8 из 13" and the range form "01-16 из 16",
 * where X = b - a + 1.
 */
export function parseXofY(input: string): XofYResult | null {
  // Range form first so "01-16 из 16" isn't matched as "16 из 16".
  const rangeRegex = new RegExp(
    `(\\d{1,3})\\s*-\\s*(\\d{1,3})\\s*(?:${xOfYWordsPattern})\\s*(\\d{1,3})`,
    'i',
  );
  const rangeMatch = input.match(rangeRegex);
  if (rangeMatch) {
    const aStr = rangeMatch[1];
    const bStr = rangeMatch[2];
    const totalStr = rangeMatch[3];
    if (aStr === undefined || bStr === undefined || totalStr === undefined) {
      return null;
    }
    const a = parseInt(aStr, 10);
    const b = parseInt(bStr, 10);
    const total = parseInt(totalStr, 10);
    return {
      present: b - a + 1,
      total,
      raw: rangeMatch[0],
    };
  }

  const singleRegex = new RegExp(
    `(\\d{1,3})\\s*(?:${xOfYWordsPattern})\\s*(\\d{1,3})`,
    'i',
  );
  const singleMatch = input.match(singleRegex);
  if (singleMatch) {
    const presentStr = singleMatch[1];
    const totalStr = singleMatch[2];
    if (presentStr === undefined || totalStr === undefined) {
      return null;
    }
    return {
      present: parseInt(presentStr, 10),
      total: parseInt(totalStr, 10),
      raw: singleMatch[0],
    };
  }

  return null;
}
