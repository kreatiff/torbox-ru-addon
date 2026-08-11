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

/** One newly auto-committed rule's worth of freshly-mapped episodes for a
 * single (title, season) pair -- runIngest groups a rule's materialised
 * mappings by season before building these, so a season-spanning torrent
 * with an exception that redirects a file to a different season still gets
 * one notification per season rather than a misleading single range. */
export interface ProcessedEpisodeNotification {
  titleName: string;
  season: number;
  episodes: number[];
}

function formatEpisodeRange(season: number, episodes: number[]): string {
  const sorted = [...episodes].sort((a, b) => a - b);
  const seasonLabel = `S${String(season).padStart(2, '0')}`;
  if (sorted.length === 1) {
    return `${seasonLabel}E${String(sorted[0]).padStart(2, '0')}`;
  }
  const first = String(sorted[0]).padStart(2, '0');
  const last = String(sorted[sorted.length - 1]).padStart(2, '0');
  return `${seasonLabel}E${first}–E${last} (${sorted.length} episodes)`;
}

/**
 * Posts one Discord embed per newly auto-committed (title, season) mapping
 * -- called from runIngest once a batch of proposals finishes, regardless
 * of what triggered that run (scheduler, admin UI button, or the TorBox
 * webhook). Same no-op/opt-in/never-throws contract as
 * notifyDiscordNewMatches above.
 */
export async function notifyDiscordEpisodesProcessed(
  entries: ProcessedEpisodeNotification[],
): Promise<void> {
  if (!config.discordWebhookUrl || entries.length === 0) {
    return;
  }

  for (const entry of entries) {
    const episodeRange = formatEpisodeRange(entry.season, entry.episodes);
    const payload = {
      embeds: [
        {
          title: `✅ ${entry.titleName}`,
          description: `${episodeRange} processed and added to the library.`,
          color: 0x82c91e,
          timestamp: new Date().toISOString(),
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
          { titleName: entry.titleName, status: response.status },
          'Discord webhook returned a non-OK status',
        );
      }
    } catch (err) {
      logger.warn({ err, titleName: entry.titleName }, 'Failed to send Discord notification');
    }
  }
}
