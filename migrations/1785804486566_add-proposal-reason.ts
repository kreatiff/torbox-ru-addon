import type { MigrationBuilder } from 'node-pg-migrate';

// Additive column per Milestone 5: stores the human-readable explanation of
// how the auto-proposal engine reached its decision. Immutable snapshot of the
// evidence present at proposal time, consistent with raw_name_at_ingest.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    alter table rules add column proposal_reason text;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    alter table rules drop column if exists proposal_reason;
  `);
}
