import { describe, it, expect } from 'vitest';
import { cascade } from '../../src/extract/cascade.js';
import { normalise } from '../../src/normalize/normalise.js';

function file(id: number, path: string, isVideo = true, size?: number) {
  return { id, path, isVideo, size };
}

describe('cascade', () => {
  it('parses Сокровища-style files: leading number + episode word', () => {
    const result = cascade(
      'Сокровища императора 3 сезон 8 из 13 выпуск (Ольга Бузова и Михаил Галустян)',
      [
        file(1, '01 выпуск.mp4'),
        file(2, '02 выпуск.mp4'),
        file(3, '08 выпуск.mp4'),
      ],
    );

    expect(result.season).toBe(3);
    expect(result.xOfY).toEqual({ present: 8, total: 13, raw: '8 из 13' });
    expect(result.files.map((f) => ({ episode: f.episode, stage: f.stage }))).toEqual([
      { episode: 1, stage: 'episodeNumber' },
      { episode: 2, stage: 'episodeNumber' },
      { episode: 8, stage: 'episodeNumber' },
    ]);
  });

  it('parses single-file torrents from the torrent name', () => {
    const result = cascade(
      'Bolshoy.Kush.s02.E02.(2026).HDTV.(1080p).by.Nicodem.Files-x',
      [file(1, 'irrelevant.mp4')],
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      season: 2,
      episode: 2,
      stage: 'seasonEpisode',
    });
  });

  it('never lets a leading bare number override an explicit SxxExx', () => {
    // Spec §3.5 invariant: Bolshoy Kush file has absolute hint 14 but SxxExx is the truth.
    // Use two files so the cascade parses file paths rather than the torrent name.
    const result = cascade(
      'Bolshoy.Kush.s02.E02.(2026).HDTV.(1080p).by.Nicodem.Files-x',
      [
        file(1, '14.Большой куш. Бангкок.s02.E02.(2026).HDTV.(1080р).ts'),
        file(2, '15.Большой куш. Париж.s02.E03.(2026).HDTV.(1080р).ts'),
      ],
    );

    expect(result.files[0]).toMatchObject({
      season: 2,
      episode: 2,
      absoluteHint: 14,
      stage: 'seasonEpisode',
    });
  });

  it('masks quality tokens so 1080p is never mistaken for an episode', () => {
    const result = cascade(
      'Some.Show.s01.E01.(2026).HDTV.(1080p).by.Nicodem',
      [file(1, 'Some.Show.s01.E01.(2026).HDTV.(1080р).by.Nicodem.mkv')],
    );

    expect(result.files[0]).toMatchObject({
      season: 1,
      episode: 1,
      stage: 'seasonEpisode',
    });
  });

  it('falls back to positional numbering for files with no episode markers', () => {
    const result = cascade('Some Show 1 сезон', [
      file(1, 'a.mp4'),
      file(2, 'b.mp4'),
      file(3, 'c.mp4'),
    ]);

    expect(result.files.map((f) => ({ episode: f.episode, stage: f.stage }))).toEqual([
      { episode: 1, stage: 'positional' },
      { episode: 2, stage: 'positional' },
      { episode: 3, stage: 'positional' },
    ]);
  });

  it('drops a size-outlier file from positional numbering instead of shifting every index (spec §3.5 stage 5)', () => {
    const result = cascade('Some Show 1 сезон', [
      file(1, 'sample.mp4', true, 20_000_000), // ~2% of the real episodes' size
      file(2, 'a.mp4', true, 1_000_000_000),
      file(3, 'b.mp4', true, 1_050_000_000),
      file(4, 'c.mp4', true, 980_000_000),
    ]);

    const bySize = new Map(result.files.map((f) => [f.fileId, f]));
    expect(bySize.get(1)).toMatchObject({ episode: null, stage: 'positional' });
    expect(bySize.get(2)).toMatchObject({ episode: 1, stage: 'positional' });
    expect(bySize.get(3)).toMatchObject({ episode: 2, stage: 'positional' });
    expect(bySize.get(4)).toMatchObject({ episode: 3, stage: 'positional' });
  });

  it('extracts air dates from the torrent name', () => {
    const result = cascade(
      'Bolshoy.Kush.s02.E02.(2026).HDTV.(1080p).by.Nicodem.Files-x (Эфир от 12.07.2026)',
      [file(1, 'episode.ts')],
    );

    expect(result.airDate).toEqual({
      date: '2026-07-12',
      // 'т' folds to Latin 't' here too, not just 'о'->'o' -- see
      // homoglyphMap.ts's case-symmetry invariant (normalise.test.ts has
      // the dedicated regression test for why both cases must fold).
      raw: 'эфиp ot 12.07.2026',
    });
  });

  it('produces a cleaned title for matching', () => {
    const result = cascade(
      'Сокровища императора 3 сезон 8 из 13 выпуск (Ольга Бузова и Михаил Галустян) [2026, путешествие]',
      [file(1, '01 выпуск.mp4')],
    );

    expect(normalise(result.cleanedTitle)).toBe(
      normalise('сокровища императора'),
    );
  });

  it('parses [S01] season and leading-number episodes in subdirectories', () => {
    const result = cascade(
      'rutor.info_Большой куш. Бангкок [S01] (2025) WEBRip 1080p от Files-x',
      [
        file(1, 'Большой куш. Бангкок.2025.WEB-DL 1080p.Files-x/01. Большой куш. Бангкок.2025.WEB-DL 1080p.Files-x.mkv'),
        file(2, 'Большой куш. Бангкок.2025.WEB-DL 1080p.Files-x/02. Большой куш. Бангкок.2025.WEB-DL 1080p.Files-x.mkv'),
      ],
    );

    expect(result.season).toBe(1);
    expect(normalise(result.cleanedTitle)).toBe(normalise('большой куш. бангкок'));
    expect(result.files.map((f) => ({ episode: f.episode, stage: f.stage }))).toEqual([
      { episode: 1, stage: 'leadingNumber' },
      { episode: 2, stage: 'leadingNumber' },
    ]);
  });
});
