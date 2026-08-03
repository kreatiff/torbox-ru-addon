import { expandContinuous, expandManual, expandParsed, expandSequential } from './numbering.js';
import type { Mapping, Rule, RuleFile } from './types.js';

function expandByMode(rule: Rule, files: RuleFile[]): Mapping[] {
  switch (rule.numbering) {
    case 'sequential':
      return expandSequential(rule, files);
    case 'continuous':
      return expandContinuous(rule, files);
    case 'manual':
      return expandManual(rule, files);
    case 'parsed':
      return expandParsed(rule, files);
  }
}

/**
 * expandRule(rule, files): Mapping[] -- pure, no I/O, no DB (spec §5.3).
 * That constraint is load-bearing, not just hygiene: it's what makes this
 * function exhaustively unit-testable (§7) and safe to bundle client-side
 * for the Labeller's live preview table (plan.md §4).
 *
 * Non-video files never produce a mapping. exceptions are resolved first,
 * per file, as an override -- a file listed there (including 'ignore')
 * never reaches its rule's numbering-mode logic, and doesn't consume a
 * position slot for the files that do (so removing a trailer doesn't shift
 * every episode after it).
 */
export function expandRule(rule: Rule, files: RuleFile[]): Mapping[] {
  const videoFiles = files.filter((f) => f.isVideo);

  const exceptionMappings: Mapping[] = [];
  const normalFiles: RuleFile[] = [];

  for (const file of videoFiles) {
    const exception = rule.exceptions[String(file.id)];
    if (exception === undefined) {
      normalFiles.push(file);
    } else if (exception === 'ignore') {
      // produces no mapping, and is excluded from the position count below
    } else {
      exceptionMappings.push({
        fileId: file.id,
        titleId: rule.titleId,
        season: exception.season,
        episode: exception.episode,
        ruleId: rule.id,
      });
    }
  }

  const modeMappings = expandByMode(rule, normalFiles);

  return [...exceptionMappings, ...modeMappings].sort((a, b) => a.fileId - b.fileId);
}
