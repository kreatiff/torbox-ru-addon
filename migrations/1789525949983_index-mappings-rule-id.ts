import type { MigrationBuilder } from 'node-pg-migrate';

// mappings.rule_id had a foreign key but no index. Postgres does not create
// one for an FK, and every code path that touches mappings by rule does so
// through `where rule_id = $1`: replaceMappingsForRule's delete (which the
// ingest run reaches once per rule, every run), listMappingsForRule's read,
// and the ON DELETE CASCADE when a rule is removed. All of those were
// sequential scans of the whole table, once per rule -- so a single ingest
// run scanned `mappings` end to end as many times as the library has rules.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    create index if not exists mappings_rule_id_idx on mappings (rule_id);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    drop index if exists mappings_rule_id_idx;
  `);
}
