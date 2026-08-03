import { pool } from '../pool.js';
import { ruleRowSchema, type RuleRow } from '../schema.types.js';
import type { Rule } from '../../resolve/types.js';

/**
 * torrent_hash/title_id have no NOT NULL in §4's DDL (transcribed verbatim —
 * see migrations/1785725438965_init-schema.ts), but a rule with either unset
 * has nothing to materialise mappings from or against. Rather than pushing
 * `| null` through Rule and every numbering function that doesn't otherwise
 * need it, that invariant is enforced once, here, at the read boundary.
 */
function toRule(row: RuleRow): Rule {
  if (row.torrent_hash === null) {
    throw new Error(`rule ${row.id} has no torrent_hash`);
  }
  if (row.title_id === null) {
    throw new Error(`rule ${row.id} has no title_id`);
  }
  return {
    id: row.id,
    torrentHash: row.torrent_hash,
    titleId: row.title_id,
    season: row.season,
    numbering: row.numbering,
    sort: row.sort,
    startEpisode: row.start_episode,
    absoluteOffset: row.absolute_offset,
    exceptions: row.exceptions,
    confidence: row.confidence,
    source: row.source,
  };
}

export async function getRuleById(id: string): Promise<Rule | undefined> {
  const result = await pool.query('select * from rules where id = $1', [id]);
  const row = result.rows[0];
  return row ? toRule(ruleRowSchema.parse(row)) : undefined;
}

export async function listRules(): Promise<Rule[]> {
  const result = await pool.query('select * from rules order by created_at');
  return result.rows.map((row) => toRule(ruleRowSchema.parse(row)));
}
