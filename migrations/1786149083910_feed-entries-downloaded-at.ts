import type { MigrationBuilder } from 'node-pg-migrate';

// Tracks the manual "Download" action (docs/rutracker-scraper-plan.md):
// NULL = never sent to TorBox; non-null = when it was. Makes the action
// idempotent -- a second click (or a re-clicked Discord link) short-circuits
// instead of re-adding the torrent or re-launching a FlareSolverr Chromium
// instance for nothing.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    alter table feed_entries add column downloaded_at timestamptz;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    alter table feed_entries drop column if exists downloaded_at;
  `);
}
