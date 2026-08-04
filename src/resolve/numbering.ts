import { naturalCompare } from '../extract/naturalSort.js';
import { cascade } from '../extract/cascade.js';
import type { Mapping, Rule, RuleFile } from './types.js';

function sortFiles(files: RuleFile[], sort: Rule['sort']): RuleFile[] {
  if (sort === 'natural') {
    return [...files].sort((a, b) => naturalCompare(a.path, b.path));
  }
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Ignore parsing entirely: sort, then count from startEpisode. The
 * deliberate human-override mode -- "don't try to interpret these
 * filenames, just number them in order." */
export function expandSequential(rule: Rule, files: RuleFile[]): Mapping[] {
  return sortFiles(files, rule.sort).map((file, index) => ({
    fileId: file.id,
    titleId: rule.titleId,
    season: rule.season,
    episode: rule.startEpisode + index,
    ruleId: rule.id,
  }));
}

/**
 * Sort, then treat startEpisode as the ABSOLUTE number of the first sorted
 * file and subtract absoluteOffset (= cumulative episode count of every
 * season before this one) to get the season-relative episode. Worked
 * example (plan.md §3.1): season 1 had 12 episodes, absolute 14 -> offset
 * 12 -> episode 2. This is positional, not per-file text parsing -- it
 * assumes a contiguous run of episodes within this torrent, which holds for
 * every case in the spec's own examples. A per-file absolute_hint from the
 * extractor cascade (Milestone 5) would only matter for a non-contiguous
 * torrent, which is not a case this spec's examples require handling yet.
 */
export function expandContinuous(rule: Rule, files: RuleFile[]): Mapping[] {
  if (rule.absoluteOffset === null) {
    throw new Error(`rule ${rule.id}: numbering 'continuous' requires absoluteOffset to be set`);
  }
  const offset = rule.absoluteOffset;
  return sortFiles(files, rule.sort).map((file, index) => ({
    fileId: file.id,
    titleId: rule.titleId,
    season: rule.season,
    episode: rule.startEpisode + index - offset,
    ruleId: rule.id,
  }));
}

/** exceptions are partitioned out before dispatch (see expandRule.ts); any
 * file that still reaches 'manual' mode has no exception entry, and under
 * 'manual' that means no mapping at all -- there is no positional fallback,
 * by definition of what distinguishes 'manual' from the other three modes. */
export function expandManual(_rule: Rule, _files: RuleFile[]): Mapping[] {
  return [];
}

/** Per-file text parsing: run the extractor cascade over the torrent name and
 * file paths, then emit a mapping from each file's parsed episode number. The
 * cascade already resolves positional fallbacks, so every video file should
 * yield an episode; any that don't are treated as a hard failure so we don't
 * silently drop files. */
export function expandParsed(rule: Rule, files: RuleFile[]): Mapping[] {
  if (!rule.torrentName) {
    throw new Error(`rule ${rule.id}: numbering 'parsed' requires torrentName to be set`);
  }

  const result = cascade(
    rule.torrentName,
    files.map((f) => ({ id: f.id, path: f.path, isVideo: f.isVideo })),
  );

  const videoFiles = result.files.filter((f) => f.isVideo);
  return videoFiles.map((file) => {
    if (file.episode === null) {
      throw new Error(
        `rule ${rule.id}: file ${file.fileId} (${file.path}) could not be assigned an episode by the cascade`,
      );
    }
    return {
      fileId: file.fileId,
      titleId: rule.titleId,
      season: file.season ?? rule.season,
      episode: file.episode,
      ruleId: rule.id,
    };
  });
}
