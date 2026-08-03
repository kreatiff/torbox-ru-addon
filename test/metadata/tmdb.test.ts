import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchTitles, fetchExternalIds, fetchSeasonDetails } from '../../src/metadata/tmdb.js';
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
      })
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
    });
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
});
