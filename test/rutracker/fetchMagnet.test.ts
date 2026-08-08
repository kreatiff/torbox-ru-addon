import { describe, it, expect, afterEach, vi } from 'vitest';
import { config } from '../../src/config.js';
import { fetchMagnetLink } from '../../src/rutracker/fetchMagnet.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchMagnetLink', () => {
  it('returns an error result (not a throw) when FLARESOLVERR_URL is unset', async () => {
    vi.spyOn(config, 'flaresolverrUrl', 'get').mockReturnValue(undefined);
    const result = await fetchMagnetLink('https://rutracker.org/forum/viewtopic.php?t=1');
    expect(result).toEqual({ ok: false, error: 'FLARESOLVERR_URL is not configured' });
  });

  it('extracts and HTML-decodes the magnet link from a solved page', async () => {
    vi.spyOn(config, 'flaresolverrUrl', 'get').mockReturnValue('http://localhost:8191');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('http://localhost:8191/v1');
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({
          cmd: 'request.get',
          url: 'https://rutracker.org/forum/viewtopic.php?t=6890150',
          maxTimeout: 60000,
        });
        return new Response(
          JSON.stringify({
            status: 'ok',
            solution: {
              response:
                '<a href="magnet:?xt=urn:btih:E4D51CF27FC7B7212880682D230B53F7800E5ECB&amp;tr=http%3A%2F%2Fbt2.t-ru.org%2Fann%3Fmagnet&amp;dn=test">magnet</a>',
            },
          }),
          { status: 200 },
        );
      }),
    );

    const result = await fetchMagnetLink('https://rutracker.org/forum/viewtopic.php?t=6890150');
    expect(result).toEqual({
      ok: true,
      magnet:
        'magnet:?xt=urn:btih:E4D51CF27FC7B7212880682D230B53F7800E5ECB&tr=http%3A%2F%2Fbt2.t-ru.org%2Fann%3Fmagnet&dn=test',
    });
  });

  it('returns an error result when FlareSolverr reports it could not solve the challenge', async () => {
    vi.spyOn(config, 'flaresolverrUrl', 'get').mockReturnValue('http://localhost:8191');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 'error', message: 'Challenge still present' }), {
            status: 200,
          }),
      ),
    );

    const result = await fetchMagnetLink('https://rutracker.org/forum/viewtopic.php?t=1');
    expect(result).toEqual({ ok: false, error: 'Challenge still present' });
  });

  it('returns an error result when the solved page has no magnet link in it', async () => {
    vi.spyOn(config, 'flaresolverrUrl', 'get').mockReturnValue('http://localhost:8191');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 'ok', solution: { response: '<html></html>' } }), {
            status: 200,
          }),
      ),
    );

    const result = await fetchMagnetLink('https://rutracker.org/forum/viewtopic.php?t=1');
    expect(result).toEqual({ ok: false, error: 'No magnet link found on the topic page' });
  });

  it('never throws when the fetch itself fails outright', async () => {
    vi.spyOn(config, 'flaresolverrUrl', 'get').mockReturnValue('http://localhost:8191');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );

    await expect(fetchMagnetLink('https://rutracker.org/forum/viewtopic.php?t=1')).resolves.toEqual({
      ok: false,
      error: 'Could not reach FlareSolverr',
    });
  });
});
