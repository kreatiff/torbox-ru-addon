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

    -- Backfill for existing installs: without this, every already-fetched
    -- torrent looks unfetched to the new listKnownHashes() query on the
    -- first ingest run after deploy, turning "just the real delta" into
    -- "the entire library" -- including a needingFetch/per-id-fallback
    -- storm that could trip TorBox rate limits or abort the run outright on
    -- a single transient API error (throttledMap has no per-item recovery).
    -- A torrent counts as already-fetched if it has at least one row in
    -- files (upsertFiles inserts every entry TorBox reports, video or
    -- not, so this is genuine evidence a real fetch happened -- not just
    -- that a torrents row exists, which is exactly the conflation that
    -- caused the bug this migration is part of fixing). Torrents left NULL
    -- here -- including any currently stuck exactly like the reported bug,
    -- pre-mapped with a rule but zero files -- correctly stay eligible for
    -- a real fetch on the next ingest run.
    update torrents set files_fetched_at = now()
    where hash in (select distinct torrent_hash from files where torrent_hash is not null);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    alter table torrents drop column if exists files_fetched_at;
  `);
}
