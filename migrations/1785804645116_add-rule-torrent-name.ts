import type { MigrationBuilder } from 'node-pg-migrate';

// Additive column: stores the torrent name snapshot used by the parsed
// numbering mode. expandRule is pure and therefore cannot look up the
// immutable raw_name_at_ingest at expansion time; the parsed rule keeps the
// string it was built against, consistent with proposal_reason.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    alter table rules add column torrent_name text;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    alter table rules drop column if exists torrent_name;
  `);
}
