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

export async function getRuleByTorrentAndSeason(
  torrentHash: string,
  season: number,
): Promise<Rule | undefined> {
  const result = await pool.query(
    'select * from rules where torrent_hash = $1 and season = $2',
    [torrentHash, season],
  );
  const row = result.rows[0];
  return row ? toRule(ruleRowSchema.parse(row)) : undefined;
}

export async function listRules(): Promise<Rule[]> {
  const result = await pool.query('select * from rules order by created_at');
  return result.rows.map((row) => toRule(ruleRowSchema.parse(row)));
}

export async function upsertRule(
  ruleData: Omit<Rule, 'id'>,
): Promise<Rule> {
  const result = await pool.query(
    `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, absolute_offset, exceptions, confidence, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (torrent_hash, season)
     do update set
       title_id = excluded.title_id,
       numbering = excluded.numbering,
       sort = excluded.sort,
       start_episode = excluded.start_episode,
       absolute_offset = excluded.absolute_offset,
       exceptions = excluded.exceptions,
       confidence = excluded.confidence,
       source = excluded.source
       -- created_at is intentionally left unchanged: it records when the rule was first created
     returning *`,
    [
      ruleData.torrentHash,
      ruleData.titleId,
      ruleData.season,
      ruleData.numbering,
      ruleData.sort,
      ruleData.startEpisode,
      ruleData.absoluteOffset,
      JSON.stringify(ruleData.exceptions),
      ruleData.confidence,
      ruleData.source,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to upsert rule');
  }
  return toRule(ruleRowSchema.parse(row));
}
