import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../pool.js';
import { mappingRowSchema, type MappingRow } from '../schema.types.js';
import type { Mapping } from '../../resolve/types.js';

function toMapping(row: MappingRow): Mapping {
  if (row.title_id === null || row.rule_id === null) {
    throw new Error(`mapping for file ${row.file_id} has no title_id/rule_id`);
  }
  return {
    fileId: row.file_id,
    titleId: row.title_id,
    season: row.season,
    episode: row.episode,
    ruleId: row.rule_id,
  };
}

/**
 * Deletes every existing mapping for this rule, then bulk-inserts the given
 * set, in one transaction. §4 calls mappings "materialised from rules; safe
 * to rebuild" -- this is that rebuild, and it's the only way mappings ever
 * get written (never edited row-by-row).
 */
export async function replaceMappingsForRule(ruleId: string, mappings: Mapping[]): Promise<void> {
  await withTransaction(async (client: PoolClient) => {
    await client.query('delete from mappings where rule_id = $1', [ruleId]);
    if (mappings.length === 0) {
      return;
    }
    await client.query(
      `insert into mappings (file_id, title_id, season, episode, rule_id)
       select * from unnest($1::bigint[], $2::uuid[], $3::int[], $4::int[], $5::uuid[])`,
      [
        mappings.map((m) => m.fileId),
        mappings.map((m) => m.titleId),
        mappings.map((m) => m.season),
        mappings.map((m) => m.episode),
        mappings.map((m) => m.ruleId),
      ],
    );
  });
}

export async function listMappingsForRule(ruleId: string): Promise<Mapping[]> {
  const result = await pool.query('select * from mappings where rule_id = $1 order by file_id', [
    ruleId,
  ]);
  return result.rows.map((row) => toMapping(mappingRowSchema.parse(row)));
}
