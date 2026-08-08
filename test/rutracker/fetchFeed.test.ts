import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchFeed } from '../../src/rutracker/fetchFeed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const xml = readFileSync(path.join(__dirname, '../fixtures/rutracker-f939.xml'), 'utf-8');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchFeed', () => {
  it('parses the real feed fixture end to end and returns all 50 entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(xml, { status: 200 })));
    const entries = await fetchFeed();
    expect(entries).toHaveLength(50);
  });

  it('never throws when the fetch itself fails -- returns an empty array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await expect(fetchFeed()).resolves.toEqual([]);
  });

  it('never throws on a non-OK HTTP status -- returns an empty array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(fetchFeed()).resolves.toEqual([]);
  });

  it('never throws on a body with no <entry> at all -- returns an empty array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<?xml version="1.0"?><feed></feed>', { status: 200 })),
    );
    await expect(fetchFeed()).resolves.toEqual([]);
  });
});
