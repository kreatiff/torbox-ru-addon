import { describe, it, expect } from 'vitest';
import { normalise } from '../../src/normalize/normalise.js';

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
});
