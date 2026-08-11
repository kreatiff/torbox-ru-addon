import type { MigrationBuilder } from 'node-pg-migrate';

// Deliberately minimal: a flat, append-only audit trail for the admin UI's
// "Recent Activity" panel (a lite alternative/complement to the Discord
// notifications in src/notify/discord.ts -- same events, but visible in-app
// without needing DISCORD_WEBHOOK_URL configured at all). `message` is a
// pre-rendered human-readable string, not structured columns: this table
// only ever needs to be displayed newest-first, never queried or joined by
// its content, so there's nothing to gain from normalising it. No FK to
// torrents/titles/feed_entries, same reasoning as play_log (§4): a log
// entry is audit data that should outlive the row it describes -- deleting
// a gone torrent (see the Health tab's purge) or editing a rule must never
// silently rewrite history.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    create table activity_log (
      id       bigserial primary key,
      source   text not null constraint activity_log_source_check check (source in ('torbox', 'rutracker')),
      message  text not null,
      at       timestamptz not null default now()
    );
    create index activity_log_at_idx on activity_log (at desc);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    drop table if exists activity_log;
  `);
}
