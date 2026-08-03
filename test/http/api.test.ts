import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { build } from '../../src/http/server.js';
import { config } from '../../src/config.js';
import { searchTitles } from '../../src/metadata/tmdb.js';

vi.mock('../../src/metadata/tmdb.js', () => ({
  searchTitles: vi.fn(),
  fetchExternalIds: vi.fn(),
  fetchSeasonDetails: vi.fn(),
}));

describe('Admin API - Basic Auth', () => {
  beforeEach(() => {
    vi.spyOn(config, 'adminUser', 'get').mockReturnValue('admin');
    vi.spyOn(config, 'adminPass', 'get').mockReturnValue('supersecret');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects requests missing auth header with 401', async () => {
    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/queue',
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Basic realm="TorBox RU Admin"');
    await app.close();
  });

  it('rejects requests with invalid credentials with 401', async () => {
    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/queue',
      headers: {
        authorization: 'Basic ' + Buffer.from('admin:wrongpassword').toString('base64'),
      },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('accepts requests with valid credentials', async () => {
    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/queue',
      headers: {
        authorization: 'Basic ' + Buffer.from('admin:supersecret').toString('base64'),
      },
    });
    // It shouldn't be 401 (if no DB, it might skip/pass or return rows depending on hasTestDb, but not 401)
    expect(response.statusCode).not.toBe(401);
    await app.close();
  });

  it('routes search query to TMDB client and returns results', async () => {
    const app = build();
    const mockResults = [
      { tmdbId: 1, nameRu: 'Title', nameEn: 'Title En', year: 2024, posterUrl: null },
    ];
    vi.mocked(searchTitles).mockResolvedValue(mockResults);

    const response = await app.inject({
      method: 'GET',
      url: '/api/titles/search?query=test',
      headers: {
        authorization: 'Basic ' + Buffer.from('admin:supersecret').toString('base64'),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(mockResults);
    expect(searchTitles).toHaveBeenCalledWith('test');
    await app.close();
  });
});
