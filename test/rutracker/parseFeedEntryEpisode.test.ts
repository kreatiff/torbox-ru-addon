import { describe, it, expect } from 'vitest';
import { parseFeedEntrySeasonEpisode } from '../../src/rutracker/parseFeedEntryEpisode.js';

describe('parseFeedEntrySeasonEpisode', () => {
  it('extracts season and episode from "N сезон: M выпуск" (real feed data)', () => {
    expect(
      parseFeedEntrySeasonEpisode(
        'Большой куш. Бангкок 2 сезон: 5 выпуск. Выпуск от 02.08.2026. [2026, ТВ-шоу, реалити-шоу, HDTV 1080p] [6.37 GB]',
      ),
    ).toEqual({ season: 2, episode: 5 });
  });

  it('extracts the present count from an "N выпуск из M" phrase (real feed data)', () => {
    expect(
      parseFeedEntrySeasonEpisode(
        'Погоня 2 сезон: 3 выпуск из 9. Выпуск от 02.08.2026. [2026, ТВ-шоу, реалити-шоу, спорт, HDTV 1080p] [4.79 GB]',
      ),
    ).toEqual({ season: 2, episode: 3 });
  });

  it('falls back to the absolute episode number when no season is stated (real feed data)', () => {
    const result = parseFeedEntrySeasonEpisode(
      '[Обновлено] Милашка Бу-Бу / Here Comes Honey Boo Boo (Сезон 1-5, серии 54 из 59) [2012–2014, Reality-TV/Реалити шоу, WEBRip 720p] [22.49 GB]',
    );
    expect(result.episode).toBe(54);
    expect(result.season).toBeNull();
  });

  it('returns nulls when neither season nor episode can be found', () => {
    expect(parseFeedEntrySeasonEpisode('Some Movie [2026, BDRip]')).toEqual({
      season: null,
      episode: null,
    });
  });
});
