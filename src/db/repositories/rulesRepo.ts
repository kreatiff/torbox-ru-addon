import { pool } from '../pool.js';
import { ruleRowSchema, type RuleRow } from '../schema.types.js';
import type { Rule } from '../../resolve/types.js';
import { MEDIUM_SCORE_THRESHOLD } from '../../resolve/confidence.js';
import { PROVIDER_MISMATCH_REASON_PREFIX } from '../../resolve/proposeRule.js';

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
    proposalReason: row.proposal_reason ?? null,
    torrentName: row.torrent_name ?? null,
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
  const result = await pool.query('select * from rules where torrent_hash = $1 and season = $2', [
    torrentHash,
    season,
  ]);
  const row = result.rows[0];
  return row ? toRule(ruleRowSchema.parse(row)) : undefined;
}

export async function listRules(): Promise<Rule[]> {
  const result = await pool.query('select * from rules order by created_at');
  return result.rows.map((row) => toRule(ruleRowSchema.parse(row)));
}

/**
 * Queued auto-proposals blocked *only* by episodesWithinProvider (see
 * PROVIDER_MISMATCH_REASON_PREFIX) -- the one queue reason that can resolve
 * itself once TMDB's season data catches up, without a human or a fresh LLM
 * call. Powers the ingest pipeline's automatic queue-retry step
 * (src/ingest/pipeline.ts's retryQueuedProviderMismatches), which re-checks
 * these each run and promotes any whose required episodes are now known.
 */
export async function listQueuedProviderMismatchRules(): Promise<Rule[]> {
  const result = await pool.query(
    `select * from rules
     where source = 'auto' and confidence < $1 and proposal_reason like $2
     order by created_at`,
    [MEDIUM_SCORE_THRESHOLD, `${PROVIDER_MISMATCH_REASON_PREFIX}%`],
  );
  return result.rows.map((row) => toRule(ruleRowSchema.parse(row)));
}

/**
 * `mappings.rule_id` is `on delete cascade` (see the init migration), so
 * this also removes every mapping this rule produced -- used when editing
 * a rule changes its season: the (torrent_hash, season) unique constraint
 * means upsertRule can't just overwrite the old row in that case (the new
 * season doesn't conflict with it), so the caller deletes the old rule
 * first to avoid leaving it -- and its now-stale mappings -- behind.
 */
export async function deleteRule(id: string): Promise<void> {
  await pool.query('delete from rules where id = $1', [id]);
}

export async function upsertRule(ruleData: Omit<Rule, 'id'>): Promise<Rule> {
  const result = await pool.query(
    `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, absolute_offset, exceptions, confidence, source, proposal_reason, torrent_name)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (torrent_hash, season)
     do update set
       title_id = excluded.title_id,
       numbering = excluded.numbering,
       sort = excluded.sort,
       start_episode = excluded.start_episode,
       absolute_offset = excluded.absolute_offset,
       exceptions = excluded.exceptions,
       confidence = excluded.confidence,
       source = excluded.source,
       proposal_reason = excluded.proposal_reason,
       torrent_name = excluded.torrent_name
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
      ruleData.proposalReason,
      ruleData.torrentName,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to upsert rule');
  }
  return toRule(ruleRowSchema.parse(row));
}
