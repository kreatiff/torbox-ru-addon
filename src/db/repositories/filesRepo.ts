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
