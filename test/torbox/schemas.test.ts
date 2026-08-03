import { describe, it, expect } from 'vitest';
import { torboxTorrentSchema, mylistResponseSchema } from '../../src/torbox/schemas.js';

describe('torboxTorrentSchema', () => {
  it('leaves files as undefined (not []) when the field is absent from the list response', () => {
    const torrent = torboxTorrentSchema.parse({ id: 1, hash: 'abc', name: 'Some Show' });
    expect(torrent.files).toBeUndefined();
  });

  it('keeps files as an empty array when the API explicitly sends one', () => {
    const torrent = torboxTorrentSchema.parse({ id: 1, hash: 'abc', name: 'Some Show', files: [] });
    expect(torrent.files).toEqual([]);
  });

  it('coerces numeric-looking string ids/sizes, since APIs are inconsistent about this', () => {
    const torrent = torboxTorrentSchema.parse({
      id: '111',
      hash: 'abc',
      name: 'Some Show',
      size: '5000',
    });
    expect(torrent.id).toBe(111);
    expect(torrent.size).toBe(5000);
  });

  it('accepts a torrent with no size/cached_at/created_at at all', () => {
    expect(() =>
      torboxTorrentSchema.parse({ id: 1, hash: 'abc', name: 'Some Show' }),
    ).not.toThrow();
  });
});

describe('mylistResponseSchema', () => {
  it('parses a mix of torrents with and without files in the same batch', () => {
    const parsed = mylistResponseSchema.parse([
      { id: 1, hash: 'a', name: 'With files', files: [{ id: 1, name: 'x.mp4', size: 1 }] },
      { id: 2, hash: 'b', name: 'Without files' },
    ]);
    expect(parsed[0]?.files).toHaveLength(1);
    expect(parsed[1]?.files).toBeUndefined();
  });
});
