import { cascade } from '../extract/cascade.js';
import type { CascadeResult } from '../extract/cascade.js';
import type { RuleProposal } from './types.js';
import { computeConfidence, type TitleMatch } from './confidence.js';

export interface TorrentInput {
  hash: string;
  rawNameAtIngest: string;
}

export interface FileInput {
  id: number;
  rawPath: string;
  isVideo: boolean;
}

/**
 * Propose a parsed rule for an unruled torrent.
 *
 * The caller is responsible for title matching and provider-season caching
 * (per the plan's sign-off). This function runs the extractor cascade,
 * computes a confidence score, and materialises a RuleProposal with the
 * immutable explanation string.
 */
export function proposeRule(
  torrent: TorrentInput,
  files: FileInput[],
  titleMatch: TitleMatch | null,
): RuleProposal {
  const cascadeResult: CascadeResult = cascade(
    torrent.rawNameAtIngest,
    files.map((f) => ({ id: f.id, path: f.rawPath, isVideo: f.isVideo })),
  );

  const confidence = computeConfidence(cascadeResult, titleMatch, true);

  const season = cascadeResult.season ?? 1;

  return {
    torrentHash: torrent.hash,
    titleId: titleMatch?.titleId ?? null,
    season,
    numbering: 'parsed',
    sort: 'natural',
    startEpisode: 1,
    absoluteOffset: null,
    exceptions: {},
    confidence: confidence.score,
    source: 'auto',
    proposalReason: confidence.explanation,
    torrentName: torrent.rawNameAtIngest,
  };
}

export { computeConfidence } from './confidence.js';
export type { TitleMatch, ConfidenceResult } from './confidence.js';
