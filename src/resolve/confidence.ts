import type { CascadeResult } from '../extract/cascade.js';

export interface ProviderSeason {
  season: number;
  episode_count: number;
  episodes: { episode: number; air_date: string | null }[];
}

export interface TitleMatch {
  titleId: string;
  nameRu: string;
  nameEn: string | null;
  seasons: ProviderSeason[];
}

export interface ConfidenceSignals {
  /** Stage 1 (explicit SxxExx) matched every in-scope file. */
  allFilesSeasonEpisode: boolean;
  /** File count == X from "X из Y" (only meaningful when xOfY is present). */
  fileCountMatchesXofY: boolean | null;
  /** File count == provider episode_count (only meaningful when no partial X из Y). */
  fileCountMatchesEpisodeCount: boolean | null;
  /** Every extracted episode number is in provider_seasons.episodes (only meaningful for partial X из Y). */
  allEpisodesInProvider: boolean | null;
  /** absolute_hint agrees with SxxExx + cumulative season offsets. */
  absoluteHintConsistent: boolean | null;
  /** At least one extracted air date matches a provider air date. */
  airDateMatched: boolean | null;
  /** Fraction of files that fell back to positional stage 5. */
  positionalFraction: number;
}

export interface ConfidenceResult {
  score: number;
  tier: 'high' | 'medium' | 'queue';
  /** Which categorical gate forced queue, if any. */
  gate: 'title' | 'xOfY' | 'positional' | null;
  signals: ConfidenceSignals;
  /** Human-readable explanation shown in the UI. */
  explanation: string;
}

const HIGH_WEIGHT = 0.35;
const SXXEXX_WEIGHT = 0.3;
const MEDIUM_WEIGHT = 0.15;
const POSITIONAL_PENALTY_MAX = 0.25;
const POSITIONAL_GATE_THRESHOLD = 0.5;
const HIGH_SCORE_THRESHOLD = 0.7;
// Exported: this is also the floor GET /api/queue and rebuildAllMappings()
// use to recognise a rule as still pending human review (source: 'auto' and
// confidence below this) -- must stay in sync with the MEDIUM tier here.
export const MEDIUM_SCORE_THRESHOLD = 0.45;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function getProviderSeason(titleMatch: TitleMatch | null, season: number): ProviderSeason | null {
  return titleMatch?.seasons.find((s) => s.season === season) ?? null;
}

function cumulativeOffsetBefore(
  titleMatch: TitleMatch | null,
  season: number,
): number | null {
  if (!titleMatch) return null;
  let offset = 0;
  for (const s of titleMatch.seasons) {
    if (s.season < season) {
      offset += s.episode_count;
    }
  }
  return offset;
}

function evaluateSignals(
  cascade: CascadeResult,
  titleMatch: TitleMatch | null,
): ConfidenceSignals {
  const videoFiles = cascade.files;
  const videoFileCount = videoFiles.length;

  const allFilesSeasonEpisode =
    videoFileCount > 0 && videoFiles.every((f) => f.stage === 'seasonEpisode');

  const xOfY = cascade.xOfY;
  let fileCountMatchesXofY: boolean | null = null;
  if (xOfY) {
    fileCountMatchesXofY = videoFileCount === xOfY.present;
  }

  const providerSeason = getProviderSeason(titleMatch, cascade.season ?? 1);

  const isPartialXofY = xOfY ? xOfY.present < xOfY.total : false;

  let fileCountMatchesEpisodeCount: boolean | null = null;
  if (providerSeason && !isPartialXofY) {
    fileCountMatchesEpisodeCount = videoFileCount === providerSeason.episode_count;
  }

  let allEpisodesInProvider: boolean | null = null;
  if (providerSeason && isPartialXofY) {
    const providerEpisodes = new Set(providerSeason.episodes.map((e) => e.episode));
    allEpisodesInProvider = videoFiles
      .filter((f) => f.episode !== null)
      .every((f) => {
        const episode = f.episode;
        return episode !== null && providerEpisodes.has(episode);
      });
  }

  let absoluteHintConsistent: boolean | null = null;
  const filesWithHints = videoFiles.filter(
    (f) => f.absoluteHint !== null && f.stage === 'seasonEpisode' && f.episode !== null,
  );
  if (filesWithHints.length > 0 && cascade.season !== null) {
    const offset = cumulativeOffsetBefore(titleMatch, cascade.season);
    if (offset !== null) {
      absoluteHintConsistent = filesWithHints.every((f) => {
        const episode = f.episode;
        if (episode === null) {
          return false;
        }
        const expected = episode + offset;
        return f.absoluteHint === expected;
      });
    }
  }

  let airDateMatched: boolean | null = null;
  if (providerSeason) {
    const providerDates = new Set(
      providerSeason.episodes
        .map((e) => e.air_date)
        .filter((d): d is string => d !== null),
    );
    const filesWithAirDates = videoFiles.filter((f) => f.airDate !== null);
    // For single-file torrents the air date is extracted from the torrent name,
    // not the file path, so also check the torrent-level airDate.
    const candidateDates = new Set(
      filesWithAirDates.map((f) => f.airDate).filter((d): d is string => d !== null),
    );
    if (cascade.airDate?.date) {
      candidateDates.add(cascade.airDate.date);
    }
    if (candidateDates.size > 0) {
      airDateMatched = [...candidateDates].some((d) => providerDates.has(d));
    }
  }

  const positionalCount = videoFiles.filter((f) => f.stage === 'positional').length;
  const positionalFraction = videoFileCount > 0 ? positionalCount / videoFileCount : 0;

  return {
    allFilesSeasonEpisode,
    fileCountMatchesXofY,
    fileCountMatchesEpisodeCount,
    allEpisodesInProvider,
    absoluteHintConsistent,
    airDateMatched,
    positionalFraction,
  };
}

function scoreSignals(signals: ConfidenceSignals): number {
  let numerator = 0;
  let denominator = 0;

  if (signals.allFilesSeasonEpisode) {
    numerator += SXXEXX_WEIGHT;
  }
  denominator += SXXEXX_WEIGHT;

  if (signals.fileCountMatchesXofY !== null) {
    if (signals.fileCountMatchesXofY) {
      numerator += HIGH_WEIGHT;
    }
    denominator += HIGH_WEIGHT;
  }

  if (signals.fileCountMatchesEpisodeCount !== null) {
    if (signals.fileCountMatchesEpisodeCount) {
      numerator += HIGH_WEIGHT;
    }
    denominator += HIGH_WEIGHT;
  }

  if (signals.allEpisodesInProvider !== null) {
    if (signals.allEpisodesInProvider) {
      numerator += HIGH_WEIGHT;
    }
    denominator += HIGH_WEIGHT;
  }

  if (signals.absoluteHintConsistent !== null) {
    if (signals.absoluteHintConsistent) {
      numerator += MEDIUM_WEIGHT;
    }
    denominator += MEDIUM_WEIGHT;
  }

  if (signals.airDateMatched !== null) {
    if (signals.airDateMatched) {
      numerator += MEDIUM_WEIGHT;
    }
    denominator += MEDIUM_WEIGHT;
  }

  // Positional penalty scales linearly with fraction of files affected,
  // reaching the full penalty at the gate-#3 boundary itself (not at 100%)
  // per the signed-off formula in decisions.md.
  const penalty =
    Math.min(signals.positionalFraction / POSITIONAL_GATE_THRESHOLD, 1) * POSITIONAL_PENALTY_MAX;
  numerator -= penalty;

  if (denominator === 0) {
    return 0;
  }

  return clamp01(numerator / denominator);
}

function hasHighSignal(signals: ConfidenceSignals): boolean {
  return (
    signals.allFilesSeasonEpisode ||
    signals.fileCountMatchesXofY === true ||
    signals.fileCountMatchesEpisodeCount === true ||
    signals.allEpisodesInProvider === true
  );
}

function buildExplanation(
  result: Omit<ConfidenceResult, 'explanation'>,
  cascade: CascadeResult,
): string {
  if (result.gate) {
    switch (result.gate) {
      case 'title':
        return 'Queued: no confident title match.';
      case 'xOfY':
        return `Queued: declared "X из Y" count (${cascade.xOfY?.present} of ${cascade.xOfY?.total}) does not match the video file count.`;
      case 'positional':
        return `Queued: more than half of files (${(result.signals.positionalFraction * 100).toFixed(0)}%) needed positional fallback.`;
    }
  }

  const parts: string[] = [];
  parts.push(`Score ${(result.score * 100).toFixed(0)}%`);

  if (result.signals.allFilesSeasonEpisode) {
    parts.push('every file has explicit SxxExx');
  }
  if (result.signals.fileCountMatchesXofY) {
    parts.push('file count matches X из Y');
  }
  if (result.signals.fileCountMatchesEpisodeCount) {
    parts.push('file count matches provider episode count');
  }
  if (result.signals.allEpisodesInProvider) {
    parts.push('all extracted episodes in provider list');
  }
  if (result.signals.absoluteHintConsistent) {
    parts.push('absolute hints consistent with season offsets');
  }
  if (result.signals.airDateMatched) {
    parts.push('air date aligns with provider');
  }
  if (result.signals.positionalFraction > 0) {
    parts.push(`${(result.signals.positionalFraction * 100).toFixed(0)}% positional fallback`);
  }

  return parts.join('; ') + '.';
}

/**
 * Computes confidence tier and explanation from cascade output and provider data.
 *
 * - Categorical gates are evaluated first; any firing forces QUEUE.
 * - Otherwise the weighted signal sum is used.
 * - HIGH: score >= 0.75 and at least one high-weight signal fired.
 * - MEDIUM: score >= 0.45.
 * - QUEUE: everything else.
 */
export function computeConfidence(
  cascade: CascadeResult,
  titleMatch: TitleMatch | null,
  hasConfidentTitleMatch: boolean,
): ConfidenceResult {
  const signals = evaluateSignals(cascade, titleMatch);
  const score = scoreSignals(signals);

  // Categorical gate #1: title match.
  if (!hasConfidentTitleMatch) {
    const result: ConfidenceResult = {
      score,
      tier: 'queue',
      gate: 'title',
      signals,
      explanation: '',
    };
    result.explanation = buildExplanation(result, cascade);
    return result;
  }

  // Categorical gate #2: X из Y mismatch.
  if (cascade.xOfY && !signals.fileCountMatchesXofY) {
    const result: ConfidenceResult = {
      score,
      tier: 'queue',
      gate: 'xOfY',
      signals,
      explanation: '',
    };
    result.explanation = buildExplanation(result, cascade);
    return result;
  }

  // Categorical gate #3: positional fallback dominates.
  if (signals.positionalFraction > POSITIONAL_GATE_THRESHOLD) {
    const result: ConfidenceResult = {
      score,
      tier: 'queue',
      gate: 'positional',
      signals,
      explanation: '',
    };
    result.explanation = buildExplanation(result, cascade);
    return result;
  }

  let tier: ConfidenceResult['tier'];
  if (score >= HIGH_SCORE_THRESHOLD && hasHighSignal(signals)) {
    tier = 'high';
  } else if (score >= MEDIUM_SCORE_THRESHOLD) {
    tier = 'medium';
  } else {
    tier = 'queue';
  }

  const result: ConfidenceResult = {
    score,
    tier,
    gate: null,
    signals,
    explanation: '',
  };
  result.explanation = buildExplanation(result, cascade);
  return result;
}
