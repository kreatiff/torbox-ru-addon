import { z } from 'zod';
import { pool } from '../pool.js';
import { fileRowSchema, type FileRow } from '../schema.types.js';

export interface File {
  id: number;
  torrentHash: string | null;
  torboxFileId: number;
  rawPath: string;
  mountPath: string | null;
  size: number;
  isVideo: boolean;
}

function toFile(row: FileRow): File {
  return {
    id: row.id,
    torrentHash: row.torrent_hash,
    torboxFileId: row.torbox_file_id,
    rawPath: row.raw_path,
    mountPath: row.mount_path,
    size: row.size,
    isVideo: row.is_video,
  };
}

export interface UpsertFileInput {
  torrentHash: string;
  torboxFileId: number;
  rawPath: string;
  size: number;
  isVideo: boolean;
}

/**
 * Bulk insert-or-refresh, one round trip via unnest(). Never touches
 * mount_path — that's populated later by the optional WebDAV mount-discovery
 * pass, not by anything the TorBox API returns, so a re-ingest must not wipe
 * a previously-discovered path.
 */
export async function upsertFiles(files: UpsertFileInput[]): Promise<File[]> {
  if (files.length === 0) {
    return [];
  }
  const result = await pool.query(
    `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
     select * from unnest($1::text[], $2::bigint[], $3::text[], $4::bigint[], $5::boolean[])
     on conflict (torrent_hash, torbox_file_id) do update set
       raw_path = excluded.raw_path,
       size = excluded.size,
       is_video = excluded.is_video
     returning *`,
    [
      files.map((f) => f.torrentHash),
      files.map((f) => f.torboxFileId),
      files.map((f) => f.rawPath),
      files.map((f) => f.size),
      files.map((f) => f.isVideo),
    ],
  );
  return result.rows.map((row) => toFile(fileRowSchema.parse(row)));
}

export async function listVideoFilesForTorrent(torrentHash: string): Promise<File[]> {
  const result = await pool.query(
    'select * from files where torrent_hash = $1 and is_video = true order by id',
    [torrentHash],
  );
  return result.rows.map((row) => toFile(fileRowSchema.parse(row)));
}

// Joined shape, not a single-table row -- kept local to this repo rather
// than schema.types.ts, which is reserved for raw per-table mirrors.
const fileWithTorrentRowSchema = z.object({
  id: z.number().int(),
  torbox_file_id: z.number().int(),
  raw_path: z.string(),
  size: z.number().int(),
  is_video: z.boolean(),
  torrent_hash: z.string().nullable(),
  torrent_torbox_id: z.number().int().nullable(),
  torrent_display_name: z.string().nullable(),
});

export interface FileWithTorrent {
  id: number;
  torboxFileId: number;
  rawPath: string;
  size: number;
  isVideo: boolean;
  torrentHash: string | null;
  torrentTorboxId: number | null;
  /** current_name if TorBox has since renamed it, else the immutable
   * raw_name_at_ingest snapshot -- never null for a file that actually has
   * a parent torrent row. */
  torrentDisplayName: string | null;
}

/**
 * Batch file+parent-torrent lookup by internal file id, for the addon
 * (Milestone 3): the stream route needs torrent display name/size for each
 * mapped file's description, and the play route needs torbox_id/
 * torbox_file_id to call TorBox's requestdl. One join, no N+1 -- both
 * routes call this (the play route with a single-element array).
 */
export async function findByIdsWithTorrent(fileIds: number[]): Promise<FileWithTorrent[]> {
  if (fileIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    `select
       f.id, f.torbox_file_id, f.raw_path, f.size, f.is_video, f.torrent_hash,
       t.torbox_id as torrent_torbox_id,
       coalesce(t.current_name, t.raw_name_at_ingest) as torrent_display_name
     from files f
     left join torrents t on t.hash = f.torrent_hash
     where f.id = any($1::bigint[])`,
    [fileIds],
  );
  return result.rows.map((row) => {
    const parsed = fileWithTorrentRowSchema.parse(row);
    return {
      id: parsed.id,
      torboxFileId: parsed.torbox_file_id,
      rawPath: parsed.raw_path,
      size: parsed.size,
      isVideo: parsed.is_video,
      torrentHash: parsed.torrent_hash,
      torrentTorboxId: parsed.torrent_torbox_id,
      torrentDisplayName: parsed.torrent_display_name,
    };
  });
}
