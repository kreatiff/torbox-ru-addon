import type { MigrationBuilder } from 'node-pg-migrate';

// Fixes a permanent no-files bug: preMapIfPossible (src/ingest/downloadFeedEntry.ts)
// upserts a torrents row at download time, *before* the torrent has any files
// in TorBox. runIngest's newTorrents/needingFetch split used to key off "hash
// already present in torrents" to decide whether a files fetch was still
// owed -- so a pre-mapped torrent's hash was already "known" by the time the
// real ingest ran, and its files were never fetched, ever (a rule existed and
// mappings rebuilt every run, but always against zero files). NULL = files
// never fetched for this hash yet; non-null = when they were. upsertTorrent's
// ON CONFLICT clause deliberately never sets this column, so the pre-map's
// seed insert can't accidentally mark it fetched.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    alter table torrents add column files_fetched_at timestamptz;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    alter table torrents drop column if exists files_fetched_at;
  `);
}
