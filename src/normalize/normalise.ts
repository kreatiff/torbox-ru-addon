import { cyrillicToLatin } from './homoglyphMap.js';

/**
 * Spec §3.1: fold Cyrillic→Latin homoglyphs, fold ё→е, collapse
 * whitespace, lowercase. This output is for matching only — never mutate
 * the display string.
 */
export function normalise(input: string): string {
  let result = '';

  for (const ch of input) {
    if (ch === 'ё' || ch === 'Ё') {
      result += ch === 'ё' ? 'е' : 'Е';
    } else {
      result += cyrillicToLatin[ch] ?? ch;
    }
  }

  return result
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
