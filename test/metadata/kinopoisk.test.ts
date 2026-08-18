import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  findKinopoiskIdByImdbId,
  fetchFilmDetails,
  fetchCast,
  fetchKinopoiskMetadata,
} from '../../src/metadata/kinopoisk.js';
import { config } from '../../src/config.js';

function jsonResponse(
  body: unknown,
  ok = true,
  status = 200,
): { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> } {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('Kinopoisk client', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.spyOn(config, 'kinopoiskApiKey', 'get').mockReturnValue('mock-kinopoisk-key');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('findKinopoiskIdByImdbId', () => {
    it('sends the X-API-KEY header and the imdbId query param', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ items: [{ kinopoiskId: 326 }] }));
      global.fetch = fetchSpy;

      const id = await findKinopoiskIdByImdbId('tt0111161');

      expect(id).toBe(326);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/v2.2/films');
      expect(url).toContain('imdbId=tt0111161');
      expect((init.headers as Record<string, string>)['X-API-KEY']).toBe('mock-kinopoisk-key');
    });

    it('returns null when no film matches the imdb id', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
      expect(await findKinopoiskIdByImdbId('tt9999999')).toBeNull();
    });
  });

  describe('fetchFilmDetails', () => {
    it('parses description/posterUrl/genres', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          description: 'Бухгалтер Энди Дюфрейн...',
          posterUrl: 'https://kinopoiskapiunofficial.tech/images/posters/kp/326.jpg',
          genres: [{ genre: 'драма' }],
        }),
      );

      const details = await fetchFilmDetails(326);
      expect(details).toEqual({
        description: 'Бухгалтер Энди Дюфрейн...',
        posterUrl: 'https://kinopoiskapiunofficial.tech/images/posters/kp/326.jpg',
        genres: ['драма'],
      });
    });

    it('returns null on a 404', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(null, false, 404));
      expect(await fetchFilmDetails(999999999)).toBeNull();
    });
  });

  describe('fetchCast', () => {
    it('keeps only actors, up to the cast limit, preferring nameRu', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        jsonResponse([
          { nameRu: 'Фрэнк Дарабонт', nameEn: 'Frank Darabont', professionKey: 'DIRECTOR' },
          { nameRu: 'Тим Роббинс', nameEn: 'Tim Robbins', professionKey: 'ACTOR' },
          { nameRu: null, nameEn: 'Morgan Freeman', professionKey: 'ACTOR' },
          { nameRu: 'Actor 3', nameEn: null, professionKey: 'ACTOR' },
          { nameRu: 'Actor 4', nameEn: null, professionKey: 'ACTOR' },
          { nameRu: 'Actor 5', nameEn: null, professionKey: 'ACTOR' },
          { nameRu: 'Actor 6 (over the limit)', nameEn: null, professionKey: 'ACTOR' },
        ]),
      );

      const cast = await fetchCast(326);
      expect(cast).toEqual(['Тим Роббинс', 'Morgan Freeman', 'Actor 3', 'Actor 4', 'Actor 5']);
    });
  });

  describe('fetchKinopoiskMetadata', () => {
    it('returns null without hitting the network when KINOPOISK_API_KEY is unset', async () => {
      vi.spyOn(config, 'kinopoiskApiKey', 'get').mockReturnValue(undefined);
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      expect(await fetchKinopoiskMetadata('tt0111161')).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null (and skips detail/staff calls) when no film matches the imdb id', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
      global.fetch = fetchSpy;

      expect(await fetchKinopoiskMetadata('tt9999999')).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('combines search + detail + staff into one KinopoiskMetadata object', async () => {
      const fetchSpy = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/api/v2.2/films?')) {
          return Promise.resolve(jsonResponse({ items: [{ kinopoiskId: 326 }] }));
        }
        if (url.includes('/api/v2.2/films/326')) {
          return Promise.resolve(
            jsonResponse({
              description: 'Бухгалтер Энди Дюфрейн...',
              posterUrl: 'https://example.com/326.jpg',
              genres: [{ genre: 'драма' }],
            }),
          );
        }
        if (url.includes('/api/v1/staff')) {
          return Promise.resolve(
            jsonResponse([{ nameRu: 'Тим Роббинс', nameEn: null, professionKey: 'ACTOR' }]),
          );
        }
        throw new Error(`unexpected URL in test: ${url}`);
      });
      global.fetch = fetchSpy;

      const result = await fetchKinopoiskMetadata('tt0111161');

      expect(result).toEqual({
        kinopoiskId: 326,
        description: 'Бухгалтер Энди Дюфрейн...',
        posterUrl: 'https://example.com/326.jpg',
        genres: ['драма'],
        cast: ['Тим Роббинс'],
      });
    });

    it('propagates a real HTTP error (not a soft null) so the caller can decide how to handle it', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse({ message: 'nope' }, false, 500));
      await expect(fetchKinopoiskMetadata('tt0111161')).rejects.toThrow(
        /Kinopoisk API returned HTTP 500/,
      );
    });
  });
});
