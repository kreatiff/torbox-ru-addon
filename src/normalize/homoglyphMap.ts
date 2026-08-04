// Spec §3.1 homoglyph table. Fold direction is Cyrillic → Latin for
// normalisation, but the table is built bidirectionally so the UI inspector
// (which highlights any character whose script differs from its surrounding
// run) can share one source of truth.

export const cyrillicToLatin: Readonly<Record<string, string>> = {
  // lowercase
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'i',
  ѕ: 's',
  ј: 'j',
  // uppercase
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  У: 'Y',
  Х: 'X',
};

export const latinToCyrillic: Readonly<Record<string, string>> = {
  // lowercase
  a: 'а',
  e: 'е',
  o: 'о',
  p: 'р',
  c: 'с',
  y: 'у',
  x: 'х',
  i: 'і',
  s: 'ѕ',
  j: 'ј',
  // uppercase
  A: 'А',
  B: 'В',
  E: 'Е',
  K: 'К',
  M: 'М',
  H: 'Н',
  O: 'О',
  P: 'Р',
  C: 'С',
  T: 'Т',
  Y: 'У',
  X: 'Х',
};

/** Every character the two alphabets confuse for one another. */
export const confusableCharacters = new Set([
  ...Object.keys(cyrillicToLatin),
  ...Object.keys(latinToCyrillic),
]);

/** True if `ch` is a known confusable (either direction). */
export function isConfusable(ch: string): boolean {
  return confusableCharacters.has(ch);
}
