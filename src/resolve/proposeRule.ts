import type { RuleException, RuleProposal } from './types.js';
import { MEDIUM_SCORE_THRESHOLD, type TitleMatch } from './confidence.js';
import type { LlmExtraction } from '../llm/opencodeZen.js';

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

export type ProposalTier = 'commit' | 'queue';

export interface RuleProposalResult {
  proposal: RuleProposal;
  tier: ProposalTier;
}

const COMMIT_CONFIDENCE = 0.9;
const QUEUE_CONFIDENCE = MEDIUM_SCORE_THRESHOLD - 0.01;

/**
 * Builds this rule's `exceptions` map from the LLM's per-file episode
 * assignments -- `numbering: 'manual'` plus a full exceptions map is enough
 * for expandRule to resolve every file without ever touching the regex
 * cascade (see src/resolve/expandRule.ts / numbering.ts's expandManual).
 * `allCovered` is false if the LLM omitted a video file from its response,
 * which forces the proposal to queue rather than silently drop a file.
 */
function buildExceptions(
  files: FileInput[],
  llm: LlmExtraction,
): { exceptions: Record<string, RuleException>; allCovered: boolean } {
  const videoFiles = files.filter((f) => f.isVideo);
  const episodeByFileId = new Map(llm.files.map((f) => [f.fileId, f.episode]));

  const exceptions: Record<string, RuleException> = {};
  let allCovered = true;
  for (const file of videoFiles) {
    if (!episodeByFileId.has(file.id)) {
      allCovered = false;
      continue;
    }
    const episode = episodeByFileId.get(file.id) ?? null;
    exceptions[String(file.id)] = episode === null ? 'ignore' : { season: llm.season, episode };
  }
  return { exceptions, allCovered };
}

/**
 * Sanity check against cached provider (TMDB) season data, when available:
 * every non-null episode the LLM assigned should be a real episode of that
 * season. Returns true (pass) when there's no provider data to check
 * against at all -- this is a floor against LLM hallucination, not a
 * requirement that provider data exist.
 */
function episodesWithinProvider(llm: LlmExtraction, titleMatch: TitleMatch | null): boolean {
  const providerSeason = titleMatch?.seasons.find((s) => s.season === llm.season);
  if (!providerSeason || providerSeason.episodes.length === 0) {
    return true;
  }
  const knownEpisodes = new Set(providerSeason.episodes.map((e) => e.episode));
  return llm.files.every((f) => f.episode === null || knownEpisodes.has(f.episode));
}

/**
 * Decides whether an LLM extraction is trustworthy enough to auto-commit,
 * and materialises a RuleProposal either way. Pure: takes the LLM's
 * already-fetched extraction and already-resolved title match, makes no
 * network/DB calls of its own (those happen in src/ingest/pipeline.ts).
 *
 * - `llm === null`: extraction unavailable (no API key, or the caller chose
 *   not to run it) -- always queues, same as a failed title match.
 * - `titleMatch === null`: the LLM ran but its title guess didn't resolve
 *   to a known or TMDB title -- always queues (expandRule requires a
 *   non-null titleId to run at all).
 * - Otherwise: commits only if the LLM reported itself confident, covered
 *   every video file, and its episode numbers agree with cached provider
 *   season data (when any is cached). Anything short of that queues, with
 *   `proposalReason` explaining why for the Labeller.
 */
export function proposeRule(
  torrent: TorrentInput,
  files: FileInput[],
  titleMatch: TitleMatch | null,
  llm: LlmExtraction | null,
): RuleProposalResult {
  if (llm === null) {
    return {
      proposal: {
        torrentHash: torrent.hash,
        titleId: null,
        season: 1,
        numbering: 'manual',
        sort: 'natural',
        startEpisode: 1,
        absoluteOffset: null,
        exceptions: {},
        confidence: 0,
        source: 'auto',
        proposalReason: 'Queued: LLM extraction unavailable (no API key configured, or the call failed).',
        torrentName: torrent.rawNameAtIngest,
      },
      tier: 'queue',
    };
  }

  const titleId = titleMatch?.titleId ?? null;
  const { exceptions, allCovered } = buildExceptions(files, llm);
  const withinProvider = episodesWithinProvider(llm, titleMatch);

  let tier: ProposalTier;
  let proposalReason: string;

  if (titleId === null) {
    tier = 'queue';
    proposalReason = `Queued: no confident title match for "${llm.title}".`;
  } else if (!allCovered) {
    tier = 'queue';
    proposalReason = 'Queued: LLM extraction did not cover every video file.';
  } else if (!withinProvider) {
    tier = 'queue';
    proposalReason = `Queued: LLM-assigned episode numbers fall outside the known season ${llm.season} episode list.`;
  } else if (!llm.confident) {
    tier = 'queue';
    proposalReason = `Queued: ${llm.reasoning}`;
  } else {
    tier = 'commit';
    proposalReason = llm.reasoning;
  }

  const proposal: RuleProposal = {
    torrentHash: torrent.hash,
    titleId,
    season: llm.season,
    numbering: 'manual',
    sort: 'natural',
    startEpisode: 1,
    absoluteOffset: null,
    exceptions,
    confidence: tier === 'commit' ? COMMIT_CONFIDENCE : QUEUE_CONFIDENCE,
    source: 'auto',
    proposalReason,
    torrentName: torrent.rawNameAtIngest,
  };

  return { proposal, tier };
}
