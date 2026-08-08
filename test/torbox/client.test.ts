import { describe, it, expect, afterEach, vi } from 'vitest';
import { addTorrentMagnet } from '../../src/torbox/client.js';
import { TorboxApiError } from '../../src/torbox/envelope.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('addTorrentMagnet', () => {
  it('posts the magnet as multipart/form-data and returns the torrent id/hash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://api.torbox.app/v1/api/torrents/createtorrent');
        expect(init.method).toBe('POST');
        expect(init.body).toBeInstanceOf(FormData);
        const form = init.body as FormData;
        expect(form.get('magnet')).toBe('magnet:?xt=urn:btih:ABC');
        return new Response(
          JSON.stringify({ success: true, data: { torrent_id: 42, hash: 'abc' } }),
          { status: 200 },
        );
      }),
    );

    const result = await addTorrentMagnet('magnet:?xt=urn:btih:ABC');
    expect(result).toEqual({ torrentId: 42, hash: 'abc' });
  });

  it('throws TorboxApiError on success:false, same as every other envelope-parsed call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: false, error: 'DUPLICATE_TORRENT', data: null }),
            { status: 200 },
          ),
      ),
    );

    await expect(addTorrentMagnet('magnet:?xt=urn:btih:ABC')).rejects.toThrow(TorboxApiError);
  });
});
