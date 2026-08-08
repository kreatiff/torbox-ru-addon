import type { MigrationBuilder } from 'node-pg-migrate';

// Additive, purely-observational feed scraper (docs/rutracker-scraper-plan.md): polls
// RuTracker's Atom feed, matches entries against existing titles, and records
// new/updated entries here. No existing table changes shape.
//
// topic_id (not a surrogate uuid) is the PK -- the RuTracker topic is the stable
// external key. bigint rather than integer: current topic IDs fit comfortably in
// integer, but there's no cost to removing the ceiling now versus a migration later.
// title_id is nullable (SET NULL on cascade) -- unmatched entries are only stored at
// all when RUTRACKER_STORE_UNMATCHED=true. notified_at is the Milestone 6
// webhook-readiness flag: NULL = not yet notified; this plan only ever writes NULL.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    create table feed_entries (
      topic_id      bigint        primary key,
      title_id      uuid          references titles(id) on delete set null,
      raw_title     text          not null,
      url           text          not null,
      first_seen    timestamptz   not null default now(),
      last_updated  timestamptz   not null,
      notified_at   timestamptz
    );
    create index feed_entries_title_id_idx on feed_entries(title_id);
    create index feed_entries_notified_at_idx on feed_entries(notified_at) where notified_at is null;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    drop table if exists feed_entries;
  `);
}
