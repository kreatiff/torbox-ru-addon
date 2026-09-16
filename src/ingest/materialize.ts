import { NotFoundError } from '../db/errors.js';
import { listVideoFilesForTorrent } from '../db/repositories/filesRepo.js';
import { listMappingsForRule, replaceMappingsForRule } from '../db/repositories/mappingsRepo.js';
import { getRuleById, listRules } from '../db/repositories/rulesRepo.js';
import { logger } from '../logger.js';
import { expandRule } from '../resolve/expandRule.js';
import { MEDIUM_SCORE_THRESHOLD } from '../resolve/confidence.js';
import type { Mapping, Rule, RuleFile } from '../resolve/types.js';

/** Same predicate GET /api/queue uses to decide a rule is still awaiting
 * human review -- an auto-proposed rule below the MEDIUM floor (whether
 * from a plain low score or a categorical gate, both of which proposeRule
 * persists below this floor) must stay inert until a human accepts it. */
function isPendingReview(rule: Rule): boolean {
  return rule.source === 'auto' && rule.confidence < MEDIUM_SCORE_THRESHOLD;
}

/**
 * Both sides are ordered by file_id -- expandRule sorts its result that way,
 * listMappingsForRule selects `order by file_id` -- so a positional compare
 * is enough and neither side needs re-sorting here. That shared ordering is
 * load-bearing: break it in either place and this degrades to "always
 * different", which is merely the old behaviour, not a correctness bug.
 */
function sameMappings(desired: Mapping[], current: Mapping[]): boolean {
  if (desired.length !== current.length) {
    return false;
  }
  return desired.every((mapping, index) => {
    const stored = current[index];
    return (
      stored !== undefined &&
      mapping.fileId === stored.fileId &&
      mapping.titleId === stored.titleId &&
      mapping.season === stored.season &&
      mapping.episode === stored.episode &&
      mapping.ruleId === stored.ruleId
    );
  });
}

/**
 * Reconcile one rule: expand it, and write only if the result differs from
 * what's already stored.
 *
 * The check-then-write matters because rebuildAllMappings runs over every
 * rule on every ingest tick (see its own comment for why that stays), and
 * replaceMappingsForRule is a delete-plus-reinsert. Unconditionally, that
 * rewrote every mapping row in the library every INGEST_INTERVAL_MINUTES
 * whether or not anything had changed -- pure write amplification, and dead
 * tuples for autovacuum to chase. In the steady state this now writes
 * nothing at all while still *checking* everything, so the self-healing
 * property callers rely on (downloadFeedEntry's pre-mapped rules become
 * mappings as soon as the torrent's files land) is unchanged.
 */
async function rebuildFor(rule: Rule): Promise<{ mappings: Mapping[]; rewritten: boolean }> {
  const files = await listVideoFilesForTorrent(rule.torrentHash);
  const ruleFiles: RuleFile[] = files.map((f) => ({
    id: f.id,
    path: f.rawPath,
    isVideo: f.isVideo,
  }));
  const mappings = expandRule(rule, ruleFiles);

  const current = await listMappingsForRule(rule.id);
  if (sameMappings(mappings, current)) {
    return { mappings, rewritten: false };
  }

  await replaceMappingsForRule(rule.id, mappings);
  return { mappings, rewritten: true };
}

/** Orchestration: DB read -> expandRule (pure) -> DB write. This is the only
 * place `mappings` ever gets written (§4: "materialised from rules; safe to
 * rebuild" -- never edited row-by-row). */
export async function rebuildMappingsForRule(ruleId: string): Promise<Mapping[]> {
  const rule = await getRuleById(ruleId);
  if (!rule) {
    throw new NotFoundError(`rule ${ruleId}`);
  }
  const { mappings } = await rebuildFor(rule);
  return mappings;
}

export interface RebuildAllSummary {
  /** Rules reconciled without error -- checked, whether or not they changed. */
  rulesProcessed: number;
  /** The subset of those whose mappings actually had to be written. Steady
   * state is 0; anything else means real work happened this run. */
  rulesRewritten: number;
  rulesFailed: number;
}

/**
 * Rebuilds mappings for every existing rule that isn't still pending human
 * review: hand-inserted or Labeller-authored/edited rules (source:
 * 'manual', confidence 1.0), and auto-proposed rules that already cleared
 * the auto-commit floor. Rules the auto-proposal step (Milestone 5)
 * inserted but withheld -- either a plain low score or a categorical gate,
 * both persisted below the MEDIUM floor -- must stay inert (no mappings,
 * visible only in the Queue) until a human accepts them via `POST
 * /api/rules`, which sets source: 'manual' and confidence: 1.0. One rule
 * failing is logged and skipped rather than aborting the rest.
 */
export async function rebuildAllMappings(): Promise<RebuildAllSummary> {
  const rules = await listRules();
  let rulesProcessed = 0;
  let rulesRewritten = 0;
  let rulesFailed = 0;

  for (const rule of rules) {
    if (isPendingReview(rule)) {
      continue;
    }
    try {
      const { rewritten } = await rebuildFor(rule);
      rulesProcessed++;
      if (rewritten) {
        rulesRewritten++;
      }
    } catch (err) {
      rulesFailed++;
      logger.error({ err, ruleId: rule.id }, 'failed to rebuild mappings for rule');
    }
  }

  return { rulesProcessed, rulesRewritten, rulesFailed };
}
