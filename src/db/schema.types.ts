import { z } from 'zod';

// Raw DB row shapes (snake_case, matching the actual columns exactly) — the
// zod-at-the-read-boundary layer that stands in for an ORM's type safety
// without maintaining a second schema representation. titles/play_log/
// provider_seasons get their row schemas added alongside the repositories
// that need them (Milestone 4+).

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

export const ruleExceptionSchema = z.union([
  z.literal('ignore'),
  z.object({ season: z.number().int(), episode: z.number().int() }),
]);

export const ruleNumberingSchema = z.enum(['sequential', 'parsed', 'continuous', 'manual']);
export const ruleSortSchema = z.enum(['natural', 'path']);
export const ruleSourceSchema = z.enum(['auto', 'manual']);

export const ruleRowSchema = z.object({
  id: z.string(),
  torrent_hash: z.string().nullable(),
  title_id: z.string().nullable(),
  season: z.number().int(),
  numbering: ruleNumberingSchema,
  sort: ruleSortSchema,
  start_episode: z.number().int(),
  absolute_offset: z.number().int().nullable(),
  exceptions: z.record(z.string(), ruleExceptionSchema),
  confidence: z.number(),
  source: ruleSourceSchema,
  created_at: z.date(),
});
export type RuleRow = z.infer<typeof ruleRowSchema>;

export const mappingRowSchema = z.object({
  file_id: z.number().int(),
  title_id: z.string().nullable(),
  season: z.number().int(),
  episode: z.number().int(),
  rule_id: z.string().nullable(),
});
export type MappingRow = z.infer<typeof mappingRowSchema>;

export const titleRowSchema = z.object({
  id: z.string(),
  imdb_id: z.string().nullable(),
  tvdb_id: z.number().int().nullable(),
  tmdb_id: z.number().int().nullable(),
  name_ru: z.string(),
  name_en: z.string().nullable(),
  year: z.number().int().nullable(),
  aliases: z.array(z.string()),
  poster_url: z.string().nullable().optional(),
});
export type TitleRow = z.infer<typeof titleRowSchema>;

export const playLogRowSchema = z.object({
  id: z.number().int(),
  file_id: z.number().int().nullable(),
  at: z.date(),
  user_agent: z.string().nullable(),
});
export type PlayLogRow = z.infer<typeof playLogRowSchema>;

export const providerSeasonRowSchema = z.object({
  title_id: z.string(),
  season: z.number().int(),
  source: z.enum(['tmdb', 'tvdb']),
  episode_count: z.number().int(),
  episodes: z.array(
    z.object({
      episode: z.number().int(),
      air_date: z.string().nullable().optional(),
    }),
  ),
  fetched_at: z.date(),
});
export type ProviderSeasonRow = z.infer<typeof providerSeasonRowSchema>;
