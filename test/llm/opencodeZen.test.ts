import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractEpisodes } from '../../src/llm/opencodeZen.js';
import { config } from '../../src/config.js';

describe('OpenCode Zen client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockKey(): void {
    vi.spyOn(config, 'opencodeZenApiKey', 'get').mockReturnValue('mock-zen-key');
  }

  function jsonResponse(content: string): Response {
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as Response;
  }

  it('returns null and does not call fetch when no API key is configured', async () => {
    vi.spyOn(config, 'opencodeZenApiKey', 'get').mockReturnValue(undefined);
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    const result = await extractEpisodes('Some Torrent', [{ fileId: 1, path: 'a.mkv' }]);

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the torrent name and files, and parses a valid extraction response', async () => {
    mockKey();
    const extraction = {
      title: 'Большой Куш',
      titleEn: 'Bolshoy Kush',
      year: 2025,
      season: 1,
      files: [{ fileId: 1, episode: 1 }],
      confident: true,
      reasoning: 'Files are sequentially numbered 01-12 with no other markers.',
    };
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(JSON.stringify(extraction)));
    global.fetch = fetchSpy;

    const result = await extractEpisodes('rutor.info_Большой куш. Бангкок [S01] (2025) WEBRip 1080p от Files-x', [
      { fileId: 1, path: '01. Большой куш.mkv', size: 6_000_000_000 },
    ]);

    expect(result).toEqual(extraction);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(init.headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer mock-zen-key' }),
    );
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(config.opencodeZenModel);
    expect(body.messages[1].content).toContain('rutor.info_Большой куш');
    expect(body.messages[1].content).toContain('fileId 1');
  });

  it('strips markdown code fences before parsing', async () => {
    mockKey();
    const extraction = {
      title: 'Show',
      titleEn: null,
      year: null,
      season: 1,
      files: [{ fileId: 1, episode: 1 }],
      confident: true,
      reasoning: 'ok',
    };
    global.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse('```json\n' + JSON.stringify(extraction) + '\n```'));

    const result = await extractEpisodes('Show', [{ fileId: 1, path: 'a.mkv' }]);
    expect(result).toEqual(extraction);
  });

  it('retries once on invalid JSON, then succeeds', async () => {
    mockKey();
    const extraction = {
      title: 'Show',
      titleEn: null,
      year: null,
      season: 1,
      files: [{ fileId: 1, episode: 1 }],
      confident: true,
      reasoning: 'ok',
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse('not json at all'))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(extraction)));
    global.fetch = fetchSpy;

    const result = await extractEpisodes('Show', [{ fileId: 1, path: 'a.mkv' }]);

    expect(result).toEqual(extraction);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws after two invalid JSON responses', async () => {
    mockKey();
    global.fetch = vi.fn().mockResolvedValue(jsonResponse('still not json'));

    await expect(extractEpisodes('Show', [{ fileId: 1, path: 'a.mkv' }])).rejects.toThrow(
      'did not return valid extraction JSON',
    );
  });

  it('throws on a non-OK HTTP response', async () => {
    mockKey();
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    } as Response);

    await expect(extractEpisodes('Show', [{ fileId: 1, path: 'a.mkv' }])).rejects.toThrow('HTTP 429');
  });
});
