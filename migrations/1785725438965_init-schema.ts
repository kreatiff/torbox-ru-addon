import type { MigrationBuilder } from 'node-pg-migrate';

// Transcribes spec §4 as closely as possible via raw SQL (pgm.sql) rather than
// the fluent builder API, to minimise translation risk against DDL the spec
// calls "close to final" and annotates with load-bearing comments. The only
// additions beyond §4 verbatim are: gen_random_uuid() defaults for the two
// uuid primary keys (the spec doesn't say how ids get generated, and Postgres
// 16 has gen_random_uuid() built in since PG13) and CHECK constraints that
// mirror the literal union types already spelled out in the Rule TS type
// (§3.7) and the torrents.status comment — enforcing invariants the spec
// already documents, not inventing new ones.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- Immutable ingest snapshot. NEVER updated after insert (raw_name_at_ingest).
    create table torrents (
      hash                text primary key,
      torbox_id           bigint not null,
      raw_name_at_ingest  text not null,
      current_name        text,
      total_size          bigint,
      cached_at           timestamptz,
      added_at            timestamptz,
      first_seen          timestamptz not null default now(),
      last_seen           timestamptz not null,
      status              text not null default 'active'
                            constraint torrents_status_check check (status in ('active', 'gone'))
    );

    create table files (
      id              bigserial primary key,
      torrent_hash    text references torrents(hash) on delete cascade,
      torbox_file_id  bigint not null,
      raw_path        text not null,
      mount_path      text,
      size            bigint not null,
      is_video        boolean not null,
      unique (torrent_hash, torbox_file_id)
    );

    -- imdb_id is nullable and is NOT the primary key: some shows have no IMDb
    -- entry, or one with no episode records for the current season. Everything
    -- else in the schema keys on titles.id.
    create table titles (
      id        uuid primary key default gen_random_uuid(),
      imdb_id   text unique,
      tvdb_id   integer unique,
      tmdb_id   integer unique,
      name_ru   text not null,
      name_en   text,
      year      integer,
      aliases   text[] not null default '{}'
    );

    create table rules (
      id              uuid primary key default gen_random_uuid(),
      torrent_hash    text references torrents(hash) on delete cascade,
      title_id        uuid references titles(id),
      season          integer not null,
      numbering       text not null
                        constraint rules_numbering_check
                        check (numbering in ('sequential', 'parsed', 'continuous', 'manual')),
      sort            text not null default 'natural'
                        constraint rules_sort_check check (sort in ('natural', 'path')),
      start_episode   integer not null default 1,
      absolute_offset integer,
      exceptions      jsonb not null default '{}',
      confidence      real not null,
      source          text not null
                        constraint rules_source_check check (source in ('auto', 'manual')),
      created_at      timestamptz not null default now(),
      unique (torrent_hash, season)
    );

    -- Materialised from rules; safe to rebuild. Keyed on file_id, not
    -- (title, season, episode) -- multiple files may map to the same episode
    -- (e.g. an "8 из 13" torrent superseded by a "13 из 13" one; both held).
    create table mappings (
      file_id   bigint references files(id) on delete cascade primary key,
      title_id  uuid references titles(id),
      season    integer not null,
      episode   integer not null,
      rule_id   uuid references rules(id) on delete cascade
    );
    create index on mappings (title_id, season, episode);

    -- No FK on file_id: play history is audit data that should outlive the
    -- row it refers to, same spirit as raw_name_at_ingest never being touched.
    create table play_log (
      id          bigserial primary key,
      file_id     bigint,
      at          timestamptz not null default now(),
      user_agent  text
    );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    drop table if exists play_log;
    drop table if exists mappings;
    drop table if exists rules;
    drop table if exists titles;
    drop table if exists files;
    drop table if exists torrents;
  `);
}
