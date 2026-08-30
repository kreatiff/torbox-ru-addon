import { z } from 'zod';

// Field names below follow the columns the spec's data model (§4) already
// commits to (torbox_id, hash, raw_name_at_ingest, total_size, cached_at,
// added_at, torbox_file_id, raw_path) on the assumption those were chosen
// against a real TorBox response. They are NOT verified against live TorBox
// API docs from this environment (no reachable API key here) — every field
// is deliberately optional/nullable where we're not certain, so a mismatch
// degrades to a logged, non-fatal gap (§5.1: "log the raw body on schema
// failure") instead of an ingest crash. Treat the first real run against a
// real account as the actual spec for this file, and tighten it then.

export const torboxFileSchema = z.object({
  id: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  name: z.string(),
  size: z.union([z.number(), z.string()]).transform((v) => Number(v)),
});
export type TorboxFile = z.infer<typeof torboxFileSchema>;

export const torboxTorrentSchema = z.object({
  id: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  hash: z.string(),
  name: z.string(),
  size: z
    .union([z.number(), z.string()])
    .transform((v) => Number(v))
    .nullable()
    .optional(),
  cached_at: z.coerce.date().nullable().optional(),
  created_at: z.coerce.date().nullable().optional(),
  // Deliberately optional+undefined-checkable (not defaulted to []) — its
  // absence, not its emptiness, is what tells ingest to fall back to a
  // per-torrent ?id= fetch. See src/torbox/client.ts. TorBox sends this as
  // JSON `null` (not just an omitted key) for at least some torrents, so
  // `.nullable()` plus the transform below normalizes null to undefined
  // rather than letting it fail validation outright.
  files: z
    .array(torboxFileSchema)
    .nullable()
    .optional()
    .transform((v) => v ?? undefined),
});
export type TorboxTorrent = z.infer<typeof torboxTorrentSchema>;

/** GET /torrents/mylist without &id= — data is an array. */
export const mylistResponseSchema = z.array(torboxTorrentSchema);

/** GET /torrents/mylist with &id=N — data is a single object, not an array. */
export const singleTorrentResponseSchema = torboxTorrentSchema;

/** POST /torrents/createtorrent (magnet field). Same "not verified against
 * live API docs" caveat as the rest of this file -- every field is
 * optional/nullable so a mismatch degrades to a logged parse failure via
 * parseEnvelope, not a crash. Unknown fields are stripped, not rejected
 * (zod's default object behaviour), so extra response fields are harmless. */
export const createTorrentResponseSchema = z.object({
  torrent_id: z
    .union([z.number(), z.string()])
    .transform((v) => Number(v))
    .nullable()
    .optional(),
  hash: z.string().nullable().optional(),
});
export type CreateTorrentResponse = z.infer<typeof createTorrentResponseSchema>;
