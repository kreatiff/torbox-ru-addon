import type { MigrationBuilder } from 'node-pg-migrate';

// Additive gap-fill, not part of spec §4 verbatim -- flagged in the plan (§3.2)
// as needing sign-off: §5.3's confidence scoring, §5.6's validation banners,
// §3.5.3's air-date extractor stage, and §5.4's show picker all need per-season
// episode counts / per-episode air dates that §4 has no column for, even
// though §5.4 explicitly says to "cache aggressively in Postgres." Keyed by
// (title, season, source) so TMDB and TVDB each keep their own view of the
// same season -- neither provider is treated as authoritative over the other.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    alter table titles add column poster_url text;

    create table provider_seasons (
      title_id      uuid not null references titles(id) on delete cascade,
      season        integer not null,
      source        text not null
                      constraint provider_seasons_source_check check (source in ('tmdb', 'tvdb')),
      episode_count integer not null,
      episodes      jsonb not null default '[]',
      fetched_at    timestamptz not null default now(),
      primary key (title_id, season, source)
    );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    drop table if exists provider_seasons;
    alter table titles drop column if exists poster_url;
  `);
}
