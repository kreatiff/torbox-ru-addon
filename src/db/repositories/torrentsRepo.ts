import { pool } from '../pool.js';
import { torrentRowSchema, type TorrentRow } from '../schema.types.js';

export interface Torrent {
  hash: string;
  torboxId: number;
  rawNameAtIngest: string;
  currentName: string | null;
  totalSize: number | null;
  cachedAt: Date | null;
  addedAt: Date | null;
  firstSeen: Date;
  lastSeen: Date;
  status: 'active' | 'gone';
  filesFetchedAt: Date | null;
}

function toTorrent(row: TorrentRow): Torrent {
  return {
    hash: row.hash,
    torboxId: row.torbox_id,
    rawNameAtIngest: row.raw_name_at_ingest,
    currentName: row.current_name,
    totalSize: row.total_size,
    cachedAt: row.cached_at,
    addedAt: row.added_at,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    status: row.status,
    filesFetchedAt: row.files_fetched_at,
  };
}

/** Single torrent by hash, or null if unknown. Promoted out of the inline
 * `pool.query` `GET /api/torrents/:hash` used to do ad hoc, so the new
 * per-torrent LLM preview endpoint can share the same lookup. */
export async function getTorrentByHash(hash: string): Promise<Torrent | null> {
  const result = await pool.query('select * from torrents where hash = $1', [hash]);
  const row = result.rows[0];
  return row ? toTorrent(torrentRowSchema.parse(row)) : null;
}

/** Every hash whose files have already been fetched from TorBox, regardless
 * of status. A torrent's file list can't change once ingested (the hash *is*
 * a content hash), so this is how ingest decides which torrents still need a
 * files fetch — capture this BEFORE upsertTorrents, not after.
 *
 * Deliberately keyed on files_fetched_at rather than mere row presence in
 * `torrents`: preMapIfPossible (src/ingest/downloadFeedEntry.ts) inserts a
 * torrents row at download time, before TorBox has any files for it, so a
 * hash can be "known" long before its files ever get fetched. */
export async function listKnownHashes(): Promise<Set<string>> {
  const result = await pool.query<{ hash: string }>(
    'select hash from torrents where files_fetched_at is not null',
  );
  return new Set(result.rows.map((r) => r.hash));
}

/** Marks these hashes' files as fetched (now()), so future ingest runs don't
 * re-fetch them. Call once per torrent after its file list has actually been
 * read from TorBox (mylist's inline files or the per-id ?id= fallback) —
 * including when that list came back empty, so a torrent with genuinely zero
 * video files doesn't get retried forever. Never called from upsertTorrent's
 * ON CONFLICT path itself, so a pre-mapped torrent (see listKnownHashes)
 * stays eligible for its real fetch. */
export async function markFilesFetched(hashes: string[]): Promise<void> {
  if (hashes.length === 0) {
    return;
  }
  await pool.query('update torrents set files_fetched_at = now() where hash = any($1::text[])', [
    hashes,
  ]);
}

export interface UpsertTorrentInput {
  hash: string;
  torboxId: number;
  name: string;
  totalSize: number | null;
  cachedAt: Date | null;
  addedAt: Date | null;
}

/**
 * Insert-or-refresh. raw_name_at_ingest is set once, from `name`, on the
 * first insert only — it is deliberately absent from the ON CONFLICT SET
 * list so a later call can never touch it. current_name tracks whatever
 * TorBox reports live. Re-upserting a torrent that had gone 'gone' flips it
 * back to 'active'. files_fetched_at is likewise absent from both the insert
 * columns and the ON CONFLICT SET list — it defaults to NULL on insert and is
 * only ever set by markFilesFetched, so calling this repeatedly (as the
 * pre-map seed and the real per-run upsert both do) never marks a torrent's
 * files fetched by accident.
 */
export async function upsertTorrent(input: UpsertTorrentInput): Promise<Torrent> {
  const result = await pool.query(
    `insert into torrents
       (hash, torbox_id, raw_name_at_ingest, current_name, total_size, cached_at, added_at, last_seen, status)
     values ($1, $2, $3, $3, $4, $5, $6, now(), 'active')
     on conflict (hash) do update set
       torbox_id = excluded.torbox_id,
       current_name = excluded.current_name,
       total_size = excluded.total_size,
       cached_at = excluded.cached_at,
       added_at = excluded.added_at,
       last_seen = now(),
       status = 'active'
     returning *`,
    [input.hash, input.torboxId, input.name, input.totalSize, input.cachedAt, input.addedAt],
  );
  return toTorrent(torrentRowSchema.parse(result.rows[0]));
}

/**
 * Marks every currently-active torrent whose hash is absent from
 * `presentHashes` as 'gone'. Refuses to do anything when `presentHashes` is
 * empty, since that's indistinguishable from a failed/empty fetch — the
 * exact "{success:false, data:null} looks like an empty library" trap the
 * spec calls out (§9), just one step downstream. The ingest pipeline should
 * also refuse to call this with an empty list from a suspicious response;
 * this is the last line of defense.
 */
/** Active torrents that have no rule row yet. This is the same set the Queue UI
 * shows, and the pipeline proposes rules for them during each ingest run. */
export async function listActiveUnruledTorrents(): Promise<Torrent[]> {
  const result = await pool.query(
    `select t.*
     from torrents t
     left join rules r on r.torrent_hash = t.hash
     where t.status = 'active' and r.id is null
     order by t.first_seen desc`,
  );
  return result.rows.map((row) => toTorrent(torrentRowSchema.parse(row)));
}

export async function markAbsentGone(presentHashes: string[]): Promise<number> {
  if (presentHashes.length === 0) {
    return 0;
  }
  const result = await pool.query(
    `update torrents set status = 'gone' where status = 'active' and hash <> all($1::text[])`,
    [presentHashes],
  );
  return result.rowCount ?? 0;
}

/**
 * Deletes a single torrent, scoped to status='gone' as a safety rail -- this
 * can never delete an active torrent even if a caller passes a bad hash.
 * Cascades to files/rules/mappings via the existing ON DELETE CASCADE FKs
 * (migrations/1785725438965_init-schema.ts); play_log has no FK and is
 * untouched, same as everywhere else audit data is kept. Returns false if no
 * matching gone torrent existed.
 */
export async function deleteTorrent(hash: string): Promise<boolean> {
  const result = await pool.query(`delete from torrents where hash = $1 and status = 'gone'`, [
    hash,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Bulk-deletes every gone torrent. Same cascade/safety-rail reasoning as
 * deleteTorrent. Returns the number of rows deleted.
 */
export async function deleteGoneTorrents(): Promise<number> {
  const result = await pool.query(`delete from torrents where status = 'gone'`);
  return result.rowCount ?? 0;
}
