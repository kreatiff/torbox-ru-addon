// Spec §3.1 homoglyph table. Fold direction is Cyrillic → Latin for
// normalisation, but the table is built bidirectionally so the UI inspector
// (which highlights any character whose script differs from its surrounding
// run) can share one source of truth.
//
// Every entry below must have both a lowercase and an uppercase pairing
// (в/В, к/К, і/І, ...), even though visual confusability genuinely differs
// by case for some of these letters (lowercase в doesn't read as a Latin b
// the way uppercase В reads as B). This is a correctness requirement, not a
// stylistic one: `normalise()` looks a character up in this table *before*
// lowercasing the whole string at the end, so if only one case of a letter
// is present, the two cases of what is semantically the same letter fold to
// different output characters -- e.g. with к missing (only К was mapped),
// normalise('Куш') produced "kyш" while normalise('куш') produced "кyш",
// silently breaking every case-insensitive title match that happened to
// involve one of the case-only letters (к/К, в/В, м/М, н/Н, т/Т, і/І, ѕ/Ѕ,
// ј/Ј). Keep both cases in lockstep if this table is ever extended.
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
  в: 'b',
  к: 'k',
  м: 'm',
  н: 'h',
  т: 't',
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
  І: 'I',
  Ѕ: 'S',
  Ј: 'J',
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
  b: 'в',
  k: 'к',
  m: 'м',
  h: 'н',
  t: 'т',
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
  I: 'І',
  S: 'Ѕ',
  J: 'Ј',
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
