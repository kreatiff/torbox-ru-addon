import { describe, it, expect } from 'vitest';
import { parseXofY } from '../../src/extract/xOfY.js';

describe('parseXofY', () => {
  it('parses "X из Y" as present count and total', () => {
    expect(parseXofY('3 сезон 8 из 13 выпуск')).toEqual({
      present: 8,
      total: 13,
      raw: '8 из 13',
    });
  });

  it('parses the range form "A-B из Y"', () => {
    expect(parseXofY('01-16 из 16')).toEqual({
      present: 16,
      total: 16,
      raw: '01-16 из 16',
    });
  });

  it('returns null when no X из Y is present', () => {
    expect(parseXofY('Bolshoy.Kush.s02.E02.(2026).HDTV')).toBeNull();
  });

  it('prefers range form over single form', () => {
    // "16 из 16" should not match first; the range should.
    expect(parseXofY('10-16 из 16')).toEqual({
      present: 7,
      total: 16,
      raw: '10-16 из 16',
    });
  });
});
