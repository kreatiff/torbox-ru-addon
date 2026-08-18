import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  searchTitles,
  fetchExternalIds,
  fetchSeasonDetails,
  findByExternalId,
  fetchTvDetails,
  resolveTitleIds,
} from '../../src/metadata/tmdb.js';
import { config } from '../../src/config.js';

describe('TMDB Client', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.spyOn(config, 'tmdbApiKey', 'get').mockReturnValue('mock-api-key');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('handles TMDB v3 API key via query parameters', async () => {
    const mockResponse = { results: [] };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });
    global.fetch = fetchSpy;

    await searchTitles('Test Show');

    expect(fetchSpy).toHaveBeenCalled();
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('api_key=mock-api-key');
    expect(calledUrl).toContain('query=Test+Show');
    expect(calledUrl).toContain('language=ru-RU');
  });

  it('handles TMDB v4 Bearer (JWT) token via Authorization headers', async () => {
    // A JWT token has dots
    vi.spyOn(config, 'tmdbApiKey', 'get').mockReturnValue('header.jwt.token');
    const mockResponse = { results: [] };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });
    global.fetch = fetchSpy;

    await searchTitles('Test Show');

    expect(fetchSpy).toHaveBeenCalled();
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    const calledInit = fetchSpy.mock.calls[0][1] as RequestInit;

    expect(calledUrl).not.toContain('api_key=');
    expect(calledInit.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer header.jwt.token',
      }),
    );
  });

  it('parses search results correctly', async () => {
    const mockResponse = {
      results: [
        {
          id: 101,
          name: 'Сокровища императора',
          original_name: 'The Treasures',
          first_air_date: '2024-03-10',
          poster_path: '/poster.jpg',
          original_language: 'ru',
        },
      ],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const results = await searchTitles('Сокровища');
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      tmdbId: 101,
      nameRu: 'Сокровища императора',
      nameEn: 'The Treasures',
      year: 2024,
      posterUrl: 'https://image.tmdb.org/t/p/w500/poster.jpg',
      originalLanguage: 'ru',
    });
  });

  it('defaults originalLanguage to null when TMDB omits it -- Russian-only auto-match gate (issue: LLM matching English shows) fails closed, not open', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { id: 101, name: 'Show', original_name: null, first_air_date: null, poster_path: null },
        ],
      }),
    });

    const results = await searchTitles('Show');
    expect(results[0]?.originalLanguage).toBeNull();
  });

  it('fetches external IDs correctly', async () => {
    const mockResponse = {
      imdb_id: 'tt9999',
      tvdb_id: 8888,
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const external = await fetchExternalIds(101);
    expect(external).toEqual({
      imdbId: 'tt9999',
      tvdbId: 8888,
    });
  });

  it('fetches season details correctly', async () => {
    const mockResponse = {
      episodes: [
        { episode_number: 1, air_date: '2024-03-10', name: 'Episode 1' },
        { episode_number: 2, air_date: '2024-03-17', name: 'Episode 2' },
      ],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const episodes = await fetchSeasonDetails(101, 1);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toEqual({ episode: 1, air_date: '2024-03-10' });
    expect(episodes[1]).toEqual({ episode: 2, air_date: '2024-03-17' });
  });

  it('finds the matching TMDB show from an external (imdb/tvdb) id', async () => {
    const mockResponse = {
      tv_results: [
        {
          id: 101,
          name: 'Сокровища императора',
          original_name: 'The Treasures',
          first_air_date: '2024-03-10',
          poster_path: '/poster.jpg',
          original_language: 'ru',
        },
      ],
    };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => mockResponse });
    global.fetch = fetchSpy;

    const result = await findByExternalId('imdb_id', 'tt9999');
    expect(result).toEqual({
      tmdbId: 101,
      nameRu: 'Сокровища императора',
      nameEn: 'The Treasures',
      year: 2024,
      posterUrl: 'https://image.tmdb.org/t/p/w500/poster.jpg',
      originalLanguage: 'ru',
    });
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/find/tt9999');
    expect(calledUrl).toContain('external_source=imdb_id');
  });

  it('returns null from findByExternalId when TMDB has no matching show', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tv_results: [] }) });
    const result = await findByExternalId('tvdb_id', 8888);
    expect(result).toBeNull();
  });

  it('fetches basic show details for a TMDB id in hand', async () => {
    const mockResponse = {
      id: 101,
      name: 'Show',
      original_name: 'Show EN',
      first_air_date: '2020-01-01',
      poster_path: '/p.jpg',
      original_language: 'ru',
    };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => mockResponse });

    const result = await fetchTvDetails(101);
    expect(result).toEqual({
      tmdbId: 101,
      nameRu: 'Show',
      nameEn: 'Show EN',
      year: 2020,
      posterUrl: 'https://image.tmdb.org/t/p/w500/p.jpg',
      originalLanguage: 'ru',
    });
  });

  describe('resolveTitleIds', () => {
    it('backfills imdb/tvdb ids and a name preview from a tmdbId alone', async () => {
      const fetchSpy = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/external_ids')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ imdb_id: 'tt42', tvdb_id: 99 }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: 101,
            name: 'Show',
            original_name: null,
            first_air_date: '2020-05-01',
            poster_path: null,
          }),
        });
      });
      global.fetch = fetchSpy;

      const result = await resolveTitleIds({ tmdbId: 101 });
      expect(result).toEqual({
        tmdbId: 101,
        imdbId: 'tt42',
        tvdbId: 99,
        nameRu: 'Show',
        nameEn: null,
        year: 2020,
        posterUrl: null,
      });
    });

    it('discovers the tmdbId (and tvdbId) from an imdbId via /find, then backfills the rest', async () => {
      const fetchSpy = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/find/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              tv_results: [
                {
                  id: 101,
                  name: 'Show',
                  original_name: null,
                  first_air_date: null,
                  poster_path: null,
                },
              ],
            }),
          });
        }
        if (url.includes('/external_ids')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ imdb_id: 'tt42', tvdb_id: 99 }),
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      global.fetch = fetchSpy;

      const result = await resolveTitleIds({ imdbId: 'tt42' });
      expect(result.tmdbId).toBe(101);
      expect(result.tvdbId).toBe(99);
      expect(result.imdbId).toBe('tt42');
      expect(result.nameRu).toBe('Show');
    });

    it('never overwrites an explicitly provided id with a discovered one', async () => {
      const fetchSpy = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/external_ids')) {
          // TMDB thinks the tvdbId is different from what the human entered.
          return Promise.resolve({
            ok: true,
            json: async () => ({ imdb_id: 'tt-tmdb', tvdb_id: 777 }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: 101,
            name: 'Show',
            original_name: null,
            first_air_date: null,
            poster_path: null,
          }),
        });
      });
      global.fetch = fetchSpy;

      const result = await resolveTitleIds({ tmdbId: 101, imdbId: 'tt-human', tvdbId: 111 });
      expect(result.imdbId).toBe('tt-human');
      expect(result.tvdbId).toBe(111);
    });

    it('returns the given ids as-is without calling TMDB when no api key is configured', async () => {
      vi.spyOn(config, 'tmdbApiKey', 'get').mockReturnValue(undefined);
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      const result = await resolveTitleIds({ imdbId: 'tt42' });
      expect(result).toEqual({
        tmdbId: null,
        imdbId: 'tt42',
        tvdbId: null,
        nameRu: null,
        nameEn: null,
        year: null,
        posterUrl: null,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
