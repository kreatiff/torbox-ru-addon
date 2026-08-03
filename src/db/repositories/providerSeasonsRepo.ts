import { pool } from '../pool.js';
import { providerSeasonRowSchema, type ProviderSeasonRow } from '../schema.types.js';

export async function getProviderSeason(
  titleId: string,
  season: number,
  source: 'tmdb' | 'tvdb',
): Promise<ProviderSeasonRow | null> {
  const result = await pool.query(
    `select * from provider_seasons
     where title_id = $1 and season = $2 and source = $3`,
    [titleId, season, source],
  );
  const row = result.rows[0];
  return row ? providerSeasonRowSchema.parse(row) : null;
}

export async function upsertProviderSeason(
  data: Omit<ProviderSeasonRow, 'fetched_at'>,
): Promise<ProviderSeasonRow> {
  const result = await pool.query(
    `insert into provider_seasons (title_id, season, source, episode_count, episodes, fetched_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (title_id, season, source)
     do update set
       episode_count = excluded.episode_count,
       episodes = excluded.episodes,
       fetched_at = now()
     returning *`,
    [
      data.title_id,
      data.season,
      data.source,
      data.episode_count,
      JSON.stringify(data.episodes),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to upsert provider season');
  }
  return providerSeasonRowSchema.parse(row);
}
