import { cascade } from '../extract/cascade.js';
import type { CascadeResult } from '../extract/cascade.js';
import type { RuleProposal } from './types.js';
import {
  computeConfidence,
  MEDIUM_SCORE_THRESHOLD,
  type ConfidenceResult,
  type TitleMatch,
} from './confidence.js';

export interface TorrentInput {
  hash: string;
  rawNameAtIngest: string;
}

export interface FileInput {
  id: number;
  rawPath: string;
  isVideo: boolean;
  size?: number;
}

export interface RuleProposalResult {
  proposal: RuleProposal;
  tier: ConfidenceResult['tier'];
  gate: ConfidenceResult['gate'];
}

/**
 * Propose a parsed rule for an unruled torrent.
 *
 * The caller is responsible for title matching and provider-season caching
 * (per the plan's sign-off). This function runs the extractor cascade,
 * computes a confidence score, and materialises a RuleProposal with the
 * immutable explanation string, alongside the tier/gate the caller must use
 * to decide whether to materialise mappings -- `proposal.confidence` is a
 * raw score, not the tier, and does not by itself reflect a fired
 * categorical gate.
 */
export function proposeRule(
  torrent: TorrentInput,
  files: FileInput[],
  titleMatch: TitleMatch | null,
): RuleProposalResult {
  const cascadeResult: CascadeResult = cascade(
    torrent.rawNameAtIngest,
    files.map((f) => ({
      id: f.id,
      path: f.rawPath,
      isVideo: f.isVideo,
      ...(f.size !== undefined ? { size: f.size } : {}),
    })),
  );

  // Whether title matching (categorical gate #1) actually found a confident
  // match -- must reflect the caller's real result, not be assumed true.
  const hasConfidentTitleMatch = titleMatch !== null;
  const confidence = computeConfidence(cascadeResult, titleMatch, hasConfidentTitleMatch);

  const season = cascadeResult.season ?? 1;

  // A categorical gate can fire with a raw score >= the MEDIUM floor (e.g.
  // every file has a clean SxxExx match but the declared X из Y count is
  // wrong) -- the persisted confidence must stay a reliable "needs review"
  // signal for the two other places that key off it (GET /api/queue's
  // predicate, rebuildAllMappings()'s skip check), neither of which knows
  // about `gate` since it isn't stored. Clamp below the floor whenever the
  // tier is 'queue', regardless of why.
  const persistedConfidence =
    confidence.tier === 'queue'
      ? Math.min(confidence.score, MEDIUM_SCORE_THRESHOLD - 0.01)
      : confidence.score;

  const proposal: RuleProposal = {
    torrentHash: torrent.hash,
    titleId: titleMatch?.titleId ?? null,
    season,
    numbering: 'parsed',
    sort: 'natural',
    startEpisode: 1,
    absoluteOffset: null,
    exceptions: {},
    confidence: persistedConfidence,
    source: 'auto',
    proposalReason: confidence.explanation,
    torrentName: torrent.rawNameAtIngest,
  };

  return { proposal, tier: confidence.tier, gate: confidence.gate };
}

export { computeConfidence } from './confidence.js';
export type { TitleMatch, ConfidenceResult } from './confidence.js';
