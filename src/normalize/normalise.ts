import { cyrillicToLatin } from './homoglyphMap.js';

/**
 * Spec §3.1: fold Cyrillic→Latin homoglyphs, fold ё→е, collapse
 * whitespace, lowercase. This output is for matching only — never mutate
 * the display string.
 *
 * ё/Ё is folded to е/Е *before* the homoglyph lookup, not instead of it --
 * the two steps compose into one canonical form. A plain е folds straight
 * to Latin e via cyrillicToLatin, so a ё that stopped at Cyrillic е instead
 * of continuing through that same lookup would normalise to a different
 * character than a plain е does, silently breaking every match between a
 * ё-spelled and an е-spelled variant of the same word (e.g. "Ёжик" vs
 * "Ежик", both real spellings of the same title).
 */
export function normalise(input: string): string {
  let result = '';

  for (const ch of input) {
    const folded = ch === 'ё' ? 'е' : ch === 'Ё' ? 'Е' : ch;
    result += cyrillicToLatin[folded] ?? folded;
  }

  return result
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
