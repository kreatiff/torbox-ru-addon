import { NotFoundError } from '../db/errors.js';
import { listVideoFilesForTorrent } from '../db/repositories/filesRepo.js';
import { replaceMappingsForRule } from '../db/repositories/mappingsRepo.js';
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

async function rebuildFor(rule: Rule): Promise<Mapping[]> {
  const files = await listVideoFilesForTorrent(rule.torrentHash);
  const ruleFiles: RuleFile[] = files.map((f) => ({
    id: f.id,
    path: f.rawPath,
    isVideo: f.isVideo,
  }));
  const mappings = expandRule(rule, ruleFiles);
  await replaceMappingsForRule(rule.id, mappings);
  return mappings;
}

/** Orchestration: DB read -> expandRule (pure) -> DB write. This is the only
 * place `mappings` ever gets written (§4: "materialised from rules; safe to
 * rebuild" -- never edited row-by-row). */
export async function rebuildMappingsForRule(ruleId: string): Promise<Mapping[]> {
  const rule = await getRuleById(ruleId);
  if (!rule) {
    throw new NotFoundError(`rule ${ruleId}`);
  }
  return rebuildFor(rule);
}

export interface RebuildAllSummary {
  rulesProcessed: number;
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
  let rulesFailed = 0;

  for (const rule of rules) {
    if (isPendingReview(rule)) {
      continue;
    }
    try {
      await rebuildFor(rule);
      rulesProcessed++;
    } catch (err) {
      rulesFailed++;
      logger.error({ err, ruleId: rule.id }, 'failed to rebuild mappings for rule');
    }
  }

  return { rulesProcessed, rulesFailed };
}
