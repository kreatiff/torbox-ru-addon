import { describe, it, expect } from 'vitest';
import { cascade } from '../../src/extract/cascade.js';
import {
  sokrovishchaImperatora,
  stavkaNaLyubov,
  bolshoyKush,
} from '../fixtures/index.js';

describe('extractor fixtures', () => {
  it('parses Сокровища императора 3 сезон 8 из 13', async () => {
    const fixture = await sokrovishchaImperatora();
    const result = cascade(
      fixture.torrentName,
      fixture.files.map((f) => ({ id: f.id, path: f.rawPath, isVideo: f.isVideo })),
    );

    expect(result.season).toBe(fixture.expectedSeason);
    expect(result.xOfY).toEqual({
      present: fixture.expectedXOfY?.present,
      total: fixture.expectedXOfY?.total,
      raw: expect.any(String),
    });
    expect(result.files).toHaveLength(8);
    for (const file of result.files) {
      expect(file.season).toBe(3);
      expect(file.stage).toBe('episodeNumber');
    }
    expect(result.files.map((f) => f.episode)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('parses Ставка на любовь 2 сезон 10 из 10', async () => {
    const fixture = await stavkaNaLyubov();
    const result = cascade(
      fixture.torrentName,
      fixture.files.map((f) => ({ id: f.id, path: f.rawPath, isVideo: f.isVideo })),
    );

    expect(result.season).toBe(fixture.expectedSeason);
    expect(result.xOfY).toEqual({
      present: fixture.expectedXOfY?.present,
      total: fixture.expectedXOfY?.total,
      raw: expect.any(String),
    });
    expect(result.files).toHaveLength(10);
    expect(result.files.map((f) => f.episode)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('parses Bolshoy Kush single-file torrent', async () => {
    const fixture = await bolshoyKush();
    const result = cascade(
      fixture.torrentName,
      fixture.files.map((f) => ({ id: f.id, path: f.rawPath, isVideo: f.isVideo })),
    );

    expect(result.season).toBe(fixture.expectedSeason);
    expect(result.airDate?.date).toBe(fixture.expectedAirDate);
    expect(result.files).toHaveLength(1);
    // Single-file torrents parse the torrent name and ignore the file path,
    // so the absolute-hint in the file name is intentionally not captured here.
    expect(result.files[0]).toMatchObject({
      season: fixture.expectedSeason,
      episode: fixture.expectedEpisode,
      stage: 'seasonEpisode',
    });
  });
});
