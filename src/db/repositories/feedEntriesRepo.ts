import { pool } from '../pool.js';
import { feedEntryRowSchema, type FeedEntryRow } from '../schema.types.js';

// Named FeedEntryRecord (not FeedEntry) to avoid colliding with
// src/rutracker/feedEntry.ts's FeedEntry -- that one is the raw Atom entry
// as parsed off the feed; this is the persisted, possibly-matched row.
export interface FeedEntryRecord {
  topicId: number;
  titleId: string | null;
  rawTitle: string;
  url: string;
  firstSeen: Date;
  lastUpdated: Date;
  notifiedAt: Date | null;
  downloadedAt: Date | null;
}

function toFeedEntryRecord(row: FeedEntryRow): FeedEntryRecord {
  return {
    topicId: row.topic_id,
    titleId: row.title_id,
    rawTitle: row.raw_title,
    url: row.url,
    firstSeen: row.first_seen,
    lastUpdated: row.last_updated,
    notifiedAt: row.notified_at,
    downloadedAt: row.downloaded_at,
  };
}

export interface UpsertFeedEntryInput {
  topicId: number;
  titleId: string | null;
  rawTitle: string;
  url: string;
  lastUpdated: Date;
}

/**
 * ON CONFLICT refreshes title_id and raw_title, not just last_updated: an
 * entry stored with title_id = NULL (RUTRACKER_STORE_UNMATCHED) must pick
 * up a real title_id if the same topic reappears in a later poll after a
 * matching title is added to the library -- updating only last_updated
 * would leave it NULL forever even after a real match exists. raw_title is
 * refreshed too since a `[Обновлено]` re-poll changes the title string
 * itself.
 */
export async function upsertFeedEntry(input: UpsertFeedEntryInput): Promise<FeedEntryRecord> {
  const result = await pool.query(
    `insert into feed_entries (topic_id, title_id, raw_title, url, last_updated)
     values ($1, $2, $3, $4, $5)
     on conflict (topic_id) do update set
       title_id = excluded.title_id,
       raw_title = excluded.raw_title,
       last_updated = excluded.last_updated
     returning *`,
    [input.topicId, input.titleId, input.rawTitle, input.url, input.lastUpdated],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to upsert feed entry');
  }
  return toFeedEntryRecord(feedEntryRowSchema.parse(row));
}

/** Which of these topic IDs already have a row -- lets the ingest step count
 * `feedEntriesNew` (first time seen) separately from re-upserts of entries
 * already known, without upsertFeedEntry needing to report insert-vs-update
 * itself. */
export async function filterExistingTopicIds(topicIds: number[]): Promise<Set<number>> {
  if (topicIds.length === 0) {
    return new Set();
  }
  const result = await pool.query('select topic_id from feed_entries where topic_id = any($1)', [
    topicIds,
  ]);
  return new Set(result.rows.map((row) => row.topic_id as number));
}

/** Drives the Discord notification step in pipeline.ts. */
export async function listUnnotifiedEntries(): Promise<FeedEntryRecord[]> {
  const result = await pool.query(
    'select * from feed_entries where notified_at is null order by last_updated',
  );
  return result.rows.map((row) => toFeedEntryRecord(feedEntryRowSchema.parse(row)));
}

/** Marks every one of these topic ids processed for notification purposes,
 * whether or not a Discord message was actually sent for it (unmatched
 * entries are marked too, so they aren't re-considered on every ingest). */
export async function markNotified(topicIds: number[]): Promise<void> {
  if (topicIds.length === 0) {
    return;
  }
  await pool.query('update feed_entries set notified_at = now() where topic_id = any($1)', [
    topicIds,
  ]);
}

export async function getFeedEntryByTopicId(topicId: number): Promise<FeedEntryRecord | null> {
  const result = await pool.query('select * from feed_entries where topic_id = $1', [topicId]);
  const row = result.rows[0];
  return row ? toFeedEntryRecord(feedEntryRowSchema.parse(row)) : null;
}

/** Idempotency marker for the manual "Download" action -- see the
 * feed-entries-downloaded-at migration for why. */
export async function markDownloaded(topicId: number): Promise<void> {
  await pool.query('update feed_entries set downloaded_at = now() where topic_id = $1', [topicId]);
}

export interface FeedEntryWithTitleName extends FeedEntryRecord {
  titleName: string | null;
}

export interface ListFeedEntriesOptions {
  limit?: number;
  offset?: number;
}

const DEFAULT_FEED_ENTRIES_LIMIT = 50;
const MAX_FEED_ENTRIES_LIMIT = 200;

/** Backs `GET /api/feed` -- newest `last_updated` first, `title_id` joined
 * to `titles.name_ru`. */
export async function listFeedEntries(
  options: ListFeedEntriesOptions = {},
): Promise<FeedEntryWithTitleName[]> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_FEED_ENTRIES_LIMIT, 1), MAX_FEED_ENTRIES_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);

  const result = await pool.query(
    `select fe.*, t.name_ru as title_name
     from feed_entries fe
     left join titles t on t.id = fe.title_id
     order by fe.last_updated desc
     limit $1 offset $2`,
    [limit, offset],
  );
  return result.rows.map((row) => ({
    ...toFeedEntryRecord(feedEntryRowSchema.parse(row)),
    titleName: (row.title_name as string | null) ?? null,
  }));
}
