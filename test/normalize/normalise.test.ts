import { describe, it, expect } from 'vitest';
import { normalise } from '../../src/normalize/normalise.js';
import { cyrillicToLatin, latinToCyrillic } from '../../src/normalize/homoglyphMap.js';

describe('normalise', () => {
  it('folds the 1080p / 1080р (U+0440) homoglyph pair', () => {
    expect(normalise('1080p')).toBe('1080p');
    expect(normalise('1080р')).toBe('1080p');
  });

  it('folds common Cyrillic→Latin confusables from the spec table', () => {
    // Lowercase confusables
    expect(normalise('а')).toBe('a');
    expect(normalise('е')).toBe('e');
    expect(normalise('о')).toBe('o');
    expect(normalise('р')).toBe('p');
    expect(normalise('с')).toBe('c');
    expect(normalise('у')).toBe('y');
    expect(normalise('х')).toBe('x');
    // Uppercase confusables
    expect(normalise('А')).toBe('a');
    expect(normalise('В')).toBe('b');
    expect(normalise('Е')).toBe('e');
    expect(normalise('Н')).toBe('h');
    expect(normalise('Р')).toBe('p');
    expect(normalise('С')).toBe('c');
    expect(normalise('Т')).toBe('t');
  });

  it('folds ё→е', () => {
    expect(normalise('ё')).toBe('е');
    expect(normalise('Ё')).toBe('е');
  });

  it('collapses whitespace and lowercases', () => {
    expect(normalise('  Bolshoy  Kush  ')).toBe('bolshoy kush');
  });

  it('leaves the original string unchanged', () => {
    const original = '1080р';
    normalise(original);
    expect(original).toBe('1080р');
  });

  it('folds the same letter identically regardless of its source casing', () => {
    // Regression: К (uppercase) used to fold to Latin K, but lowercase к had
    // no table entry at all, so 'Куш' -> "kyш" while 'куш' -> "кyш" -- two
    // different strings for the same word, breaking every case-insensitive
    // match that happened to involve one of the case-only confusables (see
    // homoglyphMap.ts's file-level comment for the full list: в/В, к/К,
    // м/М, н/Н, т/Т, і/І, ѕ/Ѕ, ј/Ј).
    expect(normalise('Куш')).toBe(normalise('куш'));
    expect(normalise('Большой Куш')).toBe(normalise('большой куш'));
    expect(normalise('ТВ')).toBe(normalise('тв'));
    expect(normalise('в')).toBe(normalise('В').toLowerCase());
    expect(normalise('м')).toBe(normalise('М').toLowerCase());
  });

  it('has a case-symmetric homoglyph table: every mapped letter has both cases mapped', () => {
    // Prevents this exact bug from being reintroduced by a future entry
    // that's added for only one case.
    for (const table of [cyrillicToLatin, latinToCyrillic]) {
      for (const ch of Object.keys(table)) {
        const other = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
        if (other === ch) continue; // no case distinction for this character
        expect(table, `missing case pairing for "${ch}" (expected "${other}" too)`).toHaveProperty(
          other,
        );
      }
    }
  });
});
