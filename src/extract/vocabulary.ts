import { normalise } from '../normalize/normalise.js';

// Spec §3.3 episode vocabulary. These words identify that a number nearby
// is an episode number, not a year/quality token.
//
// The regexes are built from the normalised forms of the words because the
// cascade receives normalised input (Cyrillic→Latin homoglyphs folded first).

const originalEpisodeWords = [
  'серия',
  'серии',
  'серию',
  'выпуск',
  'выпуска',
  'выпуски',
  'эпизод',
  'эп.',
  'часть',
];

export const originalEpisodeWordsList = originalEpisodeWords;

export const episodeWords = originalEpisodeWords.map(normalise);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive regex matching any of the episode words as a whole word. */
export function buildEpisodeWordRegex(): RegExp {
  // эп. contains a literal dot, so escape it.
  const escaped = episodeWords.map(escapeRegex);
  return new RegExp(`(?:${escaped.join('|')})`, 'i');
}

/**
 * Builds a regex that matches a number adjacent to an episode word.
 * Captures the number in group 1 or group 2.
 */
export function buildNumberWordRegex(): RegExp {
  const escaped = episodeWords.map(escapeRegex);
  const words = escaped.join('|');
  // Number before word: "01 выпуск", "01.выпуск", "01-выпуск"
  // Word before number: "выпуск 01", "выпуск.01"
  return new RegExp(
    `(?:(\\d{1,3})\\s*[-._]?\\s*(?:${words})|(?:${words})\\s*[-._]?\\s*(\\d{1,3}))`,
    'i',
  );
}
