import { describe, it, expect, afterEach, vi } from 'vitest';
import { config } from '../../src/config.js';
import { notifyDiscordNewMatches } from '../../src/notify/discord.js';
import type { FeedEntryRecord } from '../../src/db/repositories/feedEntriesRepo.js';

function entry(overrides: Partial<FeedEntryRecord> = {}): FeedEntryRecord {
  return {
    topicId: 6890150,
    titleId: 'title-1',
    rawTitle: 'Большой куш. Бангкок 2 сезон: 5 выпуск [2026]',
    url: 'https://rutracker.org/forum/viewtopic.php?t=6890150',
    firstSeen: new Date('2026-01-01T00:00:00Z'),
    lastUpdated: new Date('2026-01-01T00:00:00Z'),
    notifiedAt: null,
    downloadedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('notifyDiscordNewMatches', () => {
  it('no-ops without making any request when DISCORD_WEBHOOK_URL is unset', async () => {
    vi.spyOn(config, 'discordWebhookUrl', 'get').mockReturnValue(undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await notifyDiscordNewMatches([entry()]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no-ops on an empty entry list even when the webhook is configured', async () => {
    vi.spyOn(config, 'discordWebhookUrl', 'get').mockReturnValue('https://discord.com/api/webhooks/x');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await notifyDiscordNewMatches([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts one embed per entry with the download link as markdown, never a bare URL', async () => {
    vi.spyOn(config, 'discordWebhookUrl', 'get').mockReturnValue('https://discord.com/api/webhooks/x');
    vi.spyOn(config, 'publicBase', 'get').mockReturnValue('https://torbox.example.com');

    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(init.body as string) });
        return new Response(null, { status: 204 });
      }),
    );

    await notifyDiscordNewMatches([entry()]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://discord.com/api/webhooks/x');
    const embed = (calls[0]?.body as { embeds: { title: string; url: string; description: string }[] })
      .embeds[0];
    expect(embed?.title).toBe('Большой куш. Бангкок 2 сезон: 5 выпуск [2026]');
    expect(embed?.url).toBe('https://rutracker.org/forum/viewtopic.php?t=6890150');
    // Must be markdown [text](url), not a bare URL -- Discord auto-unfurls
    // bare links by fetching them server-side, which would silently trigger
    // this (mutating) download action before a human ever clicked it.
    expect(embed?.description).toBe(
      '[⬇️ Download to TorBox](https://torbox.example.com/api/feed/6890150/download)',
    );
  });

  it('never throws when the webhook request fails, and keeps processing remaining entries', async () => {
    vi.spyOn(config, 'discordWebhookUrl', 'get').mockReturnValue('https://discord.com/api/webhooks/x');
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++;
        throw new Error('network down');
      }),
    );

    await expect(
      notifyDiscordNewMatches([entry({ topicId: 1 }), entry({ topicId: 2 })]),
    ).resolves.toBeUndefined();
    expect(callCount).toBe(2);
  });
});
