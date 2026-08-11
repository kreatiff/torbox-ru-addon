import { pool } from '../pool.js';
import { logger } from '../../logger.js';
import {
  activityLogRowSchema,
  type activityLogSourceSchema,
  type ActivityLogRow,
} from '../schema.types.js';
import type { z } from 'zod';

export type ActivityLogSource = z.infer<typeof activityLogSourceSchema>;

export interface ActivityLogEntry {
  id: number;
  source: ActivityLogSource;
  message: string;
  at: Date;
}

function toActivityLogEntry(row: ActivityLogRow): ActivityLogEntry {
  return { id: row.id, source: row.source, message: row.message, at: row.at };
}

/**
 * Appends one entry to the in-app activity log (the Health tab's "Recent
 * Activity" panel) -- a lite, always-on alternative to the Discord
 * notifications in src/notify/discord.ts. Called from the same places that
 * build a Discord message (runIngest's proposal loop for 'torbox', pollFeed
 * for 'rutracker'), but independently of whether DISCORD_WEBHOOK_URL is
 * configured -- unlike Discord, this isn't opt-in. Never throws: a logging
 * failure shouldn't take down an ingest run any more than a Discord outage
 * does, so callers fire-and-forget this the same way they already do for
 * notifyDiscordNewMatches/notifyDiscordEpisodesProcessed.
 */
export async function logActivity(source: ActivityLogSource, message: string): Promise<void> {
  try {
    await pool.query('insert into activity_log (source, message) values ($1, $2)', [
      source,
      message,
    ]);
  } catch (err) {
    logger.warn({ err, source }, 'failed to write activity log entry');
  }
}

const DEFAULT_ACTIVITY_LIMIT = 50;
const MAX_ACTIVITY_LIMIT = 200;

/** Backs `GET /api/activity` -- newest first, capped and clamped the same
 * way listFeedEntries is. */
export async function listRecentActivity(
  limit = DEFAULT_ACTIVITY_LIMIT,
): Promise<ActivityLogEntry[]> {
  const clampedLimit = Math.min(Math.max(limit, 1), MAX_ACTIVITY_LIMIT);
  const result = await pool.query('select * from activity_log order by at desc limit $1', [
    clampedLimit,
  ]);
  return result.rows.map((row) => toActivityLogEntry(activityLogRowSchema.parse(row)));
}
