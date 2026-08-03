import { NotFoundError } from '../db/errors.js';
import { listVideoFilesForTorrent } from '../db/repositories/filesRepo.js';
import { replaceMappingsForRule } from '../db/repositories/mappingsRepo.js';
import { getRuleById, listRules } from '../db/repositories/rulesRepo.js';
import { logger } from '../logger.js';
import { expandRule } from '../resolve/expandRule.js';
import type { Mapping, Rule, RuleFile } from '../resolve/types.js';

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
 * Rebuilds mappings for every existing rule. Not gated behind "propose
 * rules" -- that step doesn't exist yet (Milestone 5) -- so this just
 * processes whatever rules already exist: hand-inserted ones (Milestone 2)
 * or ones edited directly in the DB before the Labeller UI exists
 * (Milestone 4). One rule failing (most likely: numbering 'parsed', not
 * implemented yet) is logged and skipped rather than aborting the rest.
 */
export async function rebuildAllMappings(): Promise<RebuildAllSummary> {
  const rules = await listRules();
  let rulesProcessed = 0;
  let rulesFailed = 0;

  for (const rule of rules) {
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
