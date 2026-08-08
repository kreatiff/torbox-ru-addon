import { config } from '../config.js';
import { logger } from '../logger.js';
import type { FeedEntryRecord } from '../db/repositories/feedEntriesRepo.js';

/**
 * Posts one Discord embed per matched feed entry to DISCORD_WEBHOOK_URL.
 * No-ops immediately when the webhook isn't configured -- entirely opt-in.
 * Never throws: a Discord outage or a malformed webhook URL degrades to a
 * logged warning per entry, not a failed ingest run.
 *
 * The download link is embedded as markdown (`[text](url)`), never as a
 * bare URL: Discord auto-unfurls bare links by fetching them server-side to
 * build a preview, which would trigger the (auth-gated, but still
 * mutating) download action before a human ever clicked it. Markdown links
 * are never auto-unfurled.
 */
export async function notifyDiscordNewMatches(entries: FeedEntryRecord[]): Promise<void> {
  if (!config.discordWebhookUrl || entries.length === 0) {
    return;
  }

  for (const entry of entries) {
    const downloadUrl = `${config.publicBase}/api/feed/${entry.topicId}/download`;
    const payload = {
      embeds: [
        {
          title: entry.rawTitle,
          url: entry.url,
          description: `[⬇️ Download to TorBox](${downloadUrl})`,
          color: 0x5865f2,
          timestamp: entry.lastUpdated.toISOString(),
        },
      ],
    };

    try {
      const response = await fetch(config.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        logger.warn(
          { topicId: entry.topicId, status: response.status },
          'Discord webhook returned a non-OK status',
        );
      }
    } catch (err) {
      logger.warn({ err, topicId: entry.topicId }, 'Failed to send Discord notification');
    }
  }
}
