import { z } from 'zod';

// Raw DB row shapes (snake_case, matching the actual columns exactly) — the
// zod-at-the-read-boundary layer that stands in for an ORM's type safety
// without maintaining a second schema representation. Only torrents/files are
// defined here for now (Milestone 1 scope); titles/rules/mappings/play_log/
// provider_seasons get their row schemas added alongside the repositories
// that need them.

export const torrentStatusSchema = z.enum(['active', 'gone']);

export const torrentRowSchema = z.object({
  hash: z.string(),
  torbox_id: z.number().int(),
  raw_name_at_ingest: z.string(),
  current_name: z.string().nullable(),
  total_size: z.number().int().nullable(),
  cached_at: z.date().nullable(),
  added_at: z.date().nullable(),
  first_seen: z.date(),
  last_seen: z.date(),
  status: torrentStatusSchema,
});
export type TorrentRow = z.infer<typeof torrentRowSchema>;

export const fileRowSchema = z.object({
  id: z.number().int(),
  torrent_hash: z.string().nullable(),
  torbox_file_id: z.number().int(),
  raw_path: z.string(),
  mount_path: z.string().nullable(),
  size: z.number().int(),
  is_video: z.boolean(),
});
export type FileRow = z.infer<typeof fileRowSchema>;
