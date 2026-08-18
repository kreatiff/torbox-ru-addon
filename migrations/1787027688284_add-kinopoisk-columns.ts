import type { MigrationBuilder } from 'node-pg-migrate';

// Issue #28: a Kinopoisk-backed `meta` resource so AIOStreams/Stremio get
// real Russian-language descriptions/cast/genres for this library instead
// of Cinemeta's English (or missing) ones. `kinopoisk_id` mirrors the
// existing imdb_id/tvdb_id/tmdb_id pattern -- unique, nullable, not a PK.
// `kinopoisk_checked_at` is the "already tried, whether or not a match was
// found" marker: the addon's `meta` route fetches at most once per title,
// ever, keyed on this column being null -- Kinopoisk's free tier has real
// per-day limits, so a title with no Kinopoisk match must not be re-queried
// on every single Stremio request. `kinopoisk_poster_url` is kept separate
// from the existing TMDB-backed `poster_url` rather than overwriting it --
// see decisions.md: meta prefers the Kinopoisk poster when present, but the
// catalog/stream paths that already depend on `poster_url` stay untouched.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    alter table titles add column kinopoisk_id integer unique;
    alter table titles add column kinopoisk_description text;
    alter table titles add column kinopoisk_poster_url text;
    alter table titles add column kinopoisk_genres text[] not null default '{}';
    alter table titles add column kinopoisk_cast text[] not null default '{}';
    alter table titles add column kinopoisk_checked_at timestamptz;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    alter table titles drop column if exists kinopoisk_checked_at;
    alter table titles drop column if exists kinopoisk_cast;
    alter table titles drop column if exists kinopoisk_genres;
    alter table titles drop column if exists kinopoisk_poster_url;
    alter table titles drop column if exists kinopoisk_description;
    alter table titles drop column if exists kinopoisk_id;
  `);
}
