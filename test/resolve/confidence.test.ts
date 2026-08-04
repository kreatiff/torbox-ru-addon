import { describe, it, expect } from 'vitest';
import { computeConfidence, type TitleMatch } from '../../src/resolve/confidence.js';
import { cascade } from '../../src/extract/cascade.js';
import { sokrovishchaImperatora, stavkaNaLyubov, bolshoyKush } from '../fixtures/index.js';

function titleMatch(presentEpisodes: number[]): TitleMatch {
  return {
    titleId: 'title-1',
    nameRu: 'Test Show',
    nameEn: null,
    seasons: [
      {
        season: 1,
        episode_count: presentEpisodes.length,
        episodes: presentEpisodes.map((episode) => ({ episode, air_date: null })),
      },
      {
        season: 2,
        episode_count: 10,
        episodes: Array.from({ length: 10 }, (_, i) => ({ episode: i + 1, air_date: null })),
      },
      {
        season: 3,
        episode_count: 13,
        episodes: Array.from({ length: 13 }, (_, i) => ({ episode: i + 1, air_date: null })),
      },
    ],
  };
}

function cascadeFrom(fixture: { torrentName: string; files: { id: number; rawPath: string; isVideo: boolean }[] }) {
  return cascade(
    fixture.torrentName,
    fixture.files.map((f) => ({ id: f.id, path: f.rawPath, isVideo: f.isVideo })),
  );
}

describe('computeConfidence', () => {
  it('gates to queue when no confident title match exists', async () => {
    const fixture = await sokrovishchaImperatora();
    const parsed = cascadeFrom(fixture);
    const result = computeConfidence(parsed, null, false);

    expect(result.tier).toBe('queue');
    expect(result.gate).toBe('title');
    expect(result.explanation).toMatch(/no confident title match/);
  });

  it('auto-commits a perfect Ставка на любовь 10-of-10 match', async () => {
    const fixture = await stavkaNaLyubov();
    const parsed = cascadeFrom(fixture);
    const result = computeConfidence(parsed, titleMatch([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), true);

    expect(result.tier).toBe('high');
    expect(result.gate).toBeNull();
    expect(result.signals.fileCountMatchesXofY).toBe(true);
    expect(result.signals.fileCountMatchesEpisodeCount).toBe(true);
  });

  it('queues a Сокровища императора partial upload with episode membership check', async () => {
    const fixture = await sokrovishchaImperatora();
    const parsed = cascadeFrom(fixture);
    const result = computeConfidence(parsed, titleMatch([1, 2, 3, 4, 5, 6, 7, 8]), true);

    // X < Y so provider-count signal is inapplicable; episode-membership signal applies.
    expect(result.signals.fileCountMatchesEpisodeCount).toBeNull();
    expect(result.signals.allEpisodesInProvider).toBe(true);
    expect(result.signals.fileCountMatchesXofY).toBe(true);
    expect(result.tier).toBe('high');
  });

  it('forces queue when X из Y count does not match file count', async () => {
    const parsed = cascade(
      'Сокровища императора 3 сезон 8 из 13 выпуск (Ольга Бузова и Михаил Галустян)',
      [
        { id: 1, path: '01 выпуск.mp4', isVideo: true },
        { id: 2, path: '02 выпуск.mp4', isVideo: true },
      ],
    );
    const result = computeConfidence(parsed, titleMatch([1, 2]), true);

    expect(result.tier).toBe('queue');
    expect(result.gate).toBe('xOfY');
  });

  it('forces queue when positional fallback dominates', async () => {
    const parsed = cascade('Some Show 1 сезон', [
      { id: 1, path: 'a.mp4', isVideo: true },
      { id: 2, path: 'b.mp4', isVideo: true },
      { id: 3, path: 'c.mp4', isVideo: true },
    ]);
    const result = computeConfidence(parsed, titleMatch([1, 2, 3]), true);

    expect(result.tier).toBe('queue');
    expect(result.gate).toBe('positional');
  });

  it('queues when score is below the medium threshold', async () => {
    const parsed = cascade('Some Show 1 сезон', [
      { id: 1, path: 'episode.mp4', isVideo: true },
    ]);
    const result = computeConfidence(parsed, titleMatch([1]), true);

    expect(result.tier).toBe('queue');
  });

  it('detects air-date alignment', async () => {
    const fixture = await bolshoyKush();
    const parsed = cascadeFrom(fixture);
    const tm = titleMatch([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    // Season 2, episode 2 airs on 2026-07-12.
    tm.seasons[1] = {
      season: 2,
      episode_count: 10,
      episodes: Array.from({ length: 10 }, (_, i) => ({
        episode: i + 1,
        air_date: i + 1 === 2 ? '2026-07-12' : null,
      })),
    };
    const result = computeConfidence(parsed, tm, true);

    expect(result.signals.airDateMatched).toBe(true);
  });
});
