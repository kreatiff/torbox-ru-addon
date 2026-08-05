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

/** Every hash currently in `torrents`, regardless of status. A torrent's file
 * list can't change once ingested (the hash *is* a content hash), so this is
 * how ingest decides which torrents are new enough to need a files fetch —
 * capture this BEFORE upsertTorrents, not after. */
export async function listKnownHashes(): Promise<Set<string>> {
  const result = await pool.query<{ hash: string }>('select hash from torrents');
  return new Set(result.rows.map((r) => r.hash));
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
 * back to 'active'.
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
