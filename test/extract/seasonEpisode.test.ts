import { describe, it, expect } from 'vitest';
import { parseSeasonEpisode } from '../../src/extract/seasonEpisode.js';

describe('parseSeasonEpisode', () => {
  it('parses SxxExx with dot separator', () => {
    expect(parseSeasonEpisode('s02.E04')).toEqual({
      season: 2,
      episode: 4,
      absoluteHint: null,
      airDate: null,
      stage: 'seasonEpisode',
    });
  });

  it('parses SxxExx with no separator', () => {
    expect(parseSeasonEpisode('S02E04')).toEqual({
      season: 2,
      episode: 4,
      absoluteHint: null,
      airDate: null,
      stage: 'seasonEpisode',
    });
  });

  it('parses SxxExx with underscore and dash separators', () => {
    expect(parseSeasonEpisode('s02_e04')).toEqual({
      season: 2,
      episode: 4,
      absoluteHint: null,
      airDate: null,
      stage: 'seasonEpisode',
    });
    expect(parseSeasonEpisode('S02-E04')).toEqual({
      season: 2,
      episode: 4,
      absoluteHint: null,
      airDate: null,
      stage: 'seasonEpisode',
    });
  });

  it('parses a season/episode inside a larger filename', () => {
    const result = parseSeasonEpisode('14.Большой куш.s02.E02.(2026).HDTV.(1080р).ts');
    expect(result).toEqual({
      season: 2,
      episode: 2,
      absoluteHint: null,
      airDate: null,
      stage: 'seasonEpisode',
    });
  });

  it('returns null when no SxxExx is present', () => {
    expect(parseSeasonEpisode('01 выпуск.mp4')).toBeNull();
  });
});
