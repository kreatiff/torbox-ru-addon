// Shapes of what the admin API returns and accepts, mirroring
// src/http/routes/api/index.ts. Extracted from App.tsx so a view can
// import just the handful it uses.

import type { RuleException } from '../../src/resolve/types.ts';

// --- API response / request shapes (mirrors src/http/routes/api/index.ts) ---
export interface TmdbSearchResult {
  tmdbId: number;
  nameRu: string;
  nameEn: string | null;
  year: number | null;
  posterUrl: string | null;
}

// The Labeller's "selected show" card accepts either a fresh TMDB search
// pick (no titleId -- the server resolves/creates the title from tmdbId) or
// an existing title carried over from a rule being edited (titleId set, so
// the server reuses it directly instead of re-resolving external ids).
export interface SelectedShowInfo {
  titleId?: string;
  tmdbId: number | null;
  nameRu: string;
  nameEn: string | null;
  year: number | null;
  posterUrl: string | null;
}

export interface ExistingRule {
  id: string;
  season: number;
  numbering: 'sequential' | 'parsed' | 'continuous' | 'manual';
  sort: 'natural' | 'path';
  startEpisode: number;
  absoluteOffset: number | null;
  exceptions: Record<string, RuleException>;
  title: {
    id: string;
    tmdbId: number | null;
    imdbId: string | null;
    tvdbId: number | null;
    nameRu: string;
    nameEn: string | null;
    year: number | null;
    posterUrl: string | null;
  };
}

export interface QueueItem {
  hash: string;
  rawNameAtIngest: string;
  firstSeen: string;
  fileCount: number;
  ruleId: string | null;
  proposal: {
    proposedTitle: string;
    proposedSeason: number;
    confidence: number;
    why: string;
    numbering: 'sequential' | 'parsed' | 'continuous' | 'manual';
    sort: 'natural' | 'path';
    startEpisode: number;
    absoluteOffset: number | null;
    exceptions: Record<string, RuleException>;
    // Only set once the LLM/regex proposal resolved to a known or
    // TMDB-found title -- expandRule requires a resolved title to run at
    // all (see proposeRule.ts), so a null here means there is nothing safe
    // to quick-accept; the Labeller is the only way to resolve one.
    titleId: string | null;
    title: {
      id: string;
      tmdbId: number | null;
      imdbId: string | null;
      tvdbId: number | null;
      nameRu: string;
      nameEn: string | null;
      year: number | null;
      posterUrl: string | null;
    } | null;
  };
}

export interface FileEntry {
  id: number;
  rawPath: string;
  size: number;
  isVideo: boolean;
  mountPath: string | null;
}

export interface TorrentDetails {
  hash: string;
  rawNameAtIngest: string;
  status: string;
  files: FileEntry[];
  rules: ExistingRule[];
}

export interface SaveRuleBody {
  torrentHash: string;
  season: number;
  numbering: 'sequential' | 'parsed' | 'continuous' | 'manual';
  sort: 'natural' | 'path';
  startEpisode: number;
  absoluteOffset?: number | null;
  exceptions: Record<string, RuleException>;
  title?: {
    tmdbId?: number | null;
    nameRu: string;
    nameEn?: string | null;
    year?: number | null;
    posterUrl?: string | null;
  };
  titleId?: string;
  // Set when editing an already-mapped rule (as opposed to creating a fresh
  // one from the Queue) -- lets the server clean up the old row if the edit
  // also changed the season (see docs/decisions.md).
  ruleId?: string;
}

export interface SaveRuleResponse {
  success: boolean;
  rule: unknown;
  warning?: string;
}

export interface IngestRunResult {
  success: boolean;
  message: string;
}

// POST /api/torrents/:hash/preview -- an LLM extraction run on demand for
// one torrent, NOT persisted (no rule/mappings written). The Labeller uses
// this to populate its existing form state so the human sees the live
// preview before deciding whether to Save.
export interface PreviewResponse {
  tier: 'commit' | 'queue';
  confident: boolean;
  reasoning: string;
  proposal: {
    season: number;
    numbering: 'sequential' | 'parsed' | 'continuous' | 'manual';
    sort: 'natural' | 'path';
    startEpisode: number;
    absoluteOffset: number | null;
    exceptions: Record<string, RuleException>;
  };
  title: {
    id: string;
    tmdbId: number | null;
    nameRu: string;
    nameEn: string | null;
    year: number | null;
    posterUrl: string | null;
  } | null;
}

export interface LibraryEpisode {
  episode: number;
  count: number;
  files: string[];
}

export interface LibraryRule {
  id: string;
  torrentHash: string;
  numbering: string;
  source: string;
}

export interface LibrarySeason {
  seasonNumber: number;
  mappedEpisodesCount: number;
  totalEpisodesCount: number | null;
  episodes: LibraryEpisode[];
  rules: LibraryRule[];
}

export interface LibraryItem {
  id: string;
  nameRu: string;
  nameEn: string | null;
  year: number | null;
  posterUrl: string | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  seasons: LibrarySeason[];
}

// GET /api/titles/resolve -- cross-references TMDB from whichever of
// tmdbId/imdbId/tvdbId is provided to backfill the other two, plus a
// name/year/poster preview. Nothing persisted; the Add/Edit Title modal
// uses this to let a human confirm a match before saving.
export interface ResolvedTitleIds {
  tmdbId: number | null;
  imdbId: string | null;
  tvdbId: number | null;
  nameRu: string | null;
  nameEn: string | null;
  year: number | null;
  posterUrl: string | null;
}

// POST /api/titles (create) / PATCH /api/titles/:id (edit) -- manual
// Library entry, independent of any torrent/rule.
export interface TitleFormBody {
  nameRu: string;
  nameEn?: string | null;
  year?: number | null;
  posterUrl?: string | null;
  tmdbId?: number | null;
  imdbId?: string | null;
  tvdbId?: number | null;
}

export interface TitleRecord {
  id: string;
  nameRu: string;
  nameEn: string | null;
  year: number | null;
  posterUrl: string | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
}

export interface TitleMutationResponse {
  success: boolean;
  title: TitleRecord;
  error?: string;
}

export interface GoneTorrent {
  hash: string;
  name: string;
  lastSeen: string;
}

export interface RecentPlay {
  id: number;
  at: string;
  userAgent: string | null;
  rawPath: string;
  titleRu: string;
  season: number | null;
  episode: number | null;
}

export interface HealthData {
  lastIngestRun: string | null;
  goneCount: number;
  goneTorrents: GoneTorrent[];
  danglingMappings: number;
  filesNoMountPath: number;
  recentPlays: RecentPlay[];
}

export interface NonRussianTitle {
  id: string;
  nameRu: string;
  nameEn: string | null;
  tmdbId: number | null;
  imdbId: string | null;
  originalLanguage: string | null;
  ruleCount: number;
  mappingCount: number;
}

export interface NonRussianAuditResult {
  checked: number;
  total: number;
  flagged: NonRussianTitle[];
}

export interface ActivityEntry {
  id: number;
  source: 'torbox' | 'rutracker';
  message: string;
  at: string;
}

export interface FeedItem {
  topicId: number;
  titleId: string | null;
  titleName: string | null;
  rawTitle: string;
  url: string;
  firstSeen: string;
  lastUpdated: string;
  notifiedAt: string | null;
  downloadedAt: string | null;
  season: number | null;
  episode: number | null;
  alreadyInLibrary: boolean;
}

export interface DownloadFeedEntryResponse {
  success: boolean;
  alreadyDownloaded?: boolean;
  rawTitle?: string;
  error?: string;
}

export interface MatchFeedEntryResponse {
  success: boolean;
  error?: string;
}

export interface RefreshFeedResponse {
  success: boolean;
  feedEntriesMatched?: number;
  feedEntriesNew?: number;
  error?: string;
}
