import React, { useState, useEffect } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import {
  List,
  Tag,
  FolderOpen,
  Activity,
  CheckCircle,
  AlertTriangle,
  Search,
  RefreshCw,
  Clock,
  Database,
  FileText,
  Rss,
  Download,
  ExternalLink,
  Trash2,
  X,
  Box,
  Loader2,
  Pencil,
} from 'lucide-react';

// Import the pure expandRule function and types from our backend src. Only
// resolve/{expandRule,types}.ts qualify for this -- they're genuinely
// dependency-free (plan.md). src/metadata/tmdb.ts pulls in zod/pino via
// config.ts/logger.ts, so its shape is mirrored locally below instead of
// imported, to avoid needing the backend's node_modules to build the UI.
import { expandRule } from '../../src/resolve/expandRule.ts';
import type { RuleFile, Mapping, Rule, RuleException } from '../../src/resolve/types.ts';

// --- API response / request shapes (mirrors src/http/routes/api/index.ts) ---
interface TmdbSearchResult {
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
interface SelectedShowInfo {
  titleId?: string;
  tmdbId: number | null;
  nameRu: string;
  nameEn: string | null;
  year: number | null;
  posterUrl: string | null;
}

interface ExistingRule {
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

interface QueueItem {
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

interface FileEntry {
  id: number;
  rawPath: string;
  size: number;
  isVideo: boolean;
  mountPath: string | null;
}

interface TorrentDetails {
  hash: string;
  rawNameAtIngest: string;
  status: string;
  files: FileEntry[];
  rules: ExistingRule[];
}

interface SaveRuleBody {
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

interface SaveRuleResponse {
  success: boolean;
  rule: unknown;
  warning?: string;
}

interface IngestRunResult {
  success: boolean;
  message: string;
}

// POST /api/torrents/:hash/preview -- an LLM extraction run on demand for
// one torrent, NOT persisted (no rule/mappings written). The Labeller uses
// this to populate its existing form state so the human sees the live
// preview before deciding whether to Save.
interface PreviewResponse {
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

interface LibraryEpisode {
  episode: number;
  count: number;
  files: string[];
}

interface LibraryRule {
  id: string;
  torrentHash: string;
  numbering: string;
  source: string;
}

interface LibrarySeason {
  seasonNumber: number;
  mappedEpisodesCount: number;
  totalEpisodesCount: number | null;
  episodes: LibraryEpisode[];
  rules: LibraryRule[];
}

interface LibraryItem {
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
interface ResolvedTitleIds {
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
interface TitleFormBody {
  nameRu: string;
  nameEn?: string | null;
  year?: number | null;
  posterUrl?: string | null;
  tmdbId?: number | null;
  imdbId?: string | null;
  tvdbId?: number | null;
}

interface TitleRecord {
  id: string;
  nameRu: string;
  nameEn: string | null;
  year: number | null;
  posterUrl: string | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
}

interface TitleMutationResponse {
  success: boolean;
  title: TitleRecord;
  error?: string;
}

interface GoneTorrent {
  hash: string;
  name: string;
  lastSeen: string;
}

interface RecentPlay {
  id: number;
  at: string;
  userAgent: string | null;
  rawPath: string;
  titleRu: string;
  season: number | null;
  episode: number | null;
}

interface HealthData {
  lastIngestRun: string | null;
  goneCount: number;
  goneTorrents: GoneTorrent[];
  danglingMappings: number;
  filesNoMountPath: number;
  recentPlays: RecentPlay[];
}

interface ActivityEntry {
  id: number;
  source: 'torbox' | 'rutracker';
  message: string;
  at: string;
}

interface FeedItem {
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

interface DownloadFeedEntryResponse {
  success: boolean;
  alreadyDownloaded?: boolean;
  rawTitle?: string;
  error?: string;
}

interface MatchFeedEntryResponse {
  success: boolean;
  error?: string;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

// Base fetcher helper.
// No Authorization header is injected here: the browser's native Basic Auth dialog
// (triggered by the WWW-Authenticate: Basic response from the server) handles credential
// storage and automatically re-sends them on every request under /admin and /api.
async function apiFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, options);
  if (!res.ok) {
    // Routes like POST/PATCH /api/titles return a JSON {error: "..."} body
    // with their non-2xx status (e.g. 409 on a provider-id conflict) --
    // surface that specific message instead of the generic status text
    // whenever the body parses as JSON with one.
    let detail = res.statusText;
    try {
      const body = (await res.clone().json()) as { error?: string };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      // Non-JSON error body -- fall back to statusText above.
    }
    throw new Error(`API error: ${detail} (${res.status})`);
  }
  return res.json() as Promise<T>;
}

// Majority-script homoglyph detector and renderer
function highlightHomoglyphs(name: string): React.ReactNode {
  // Split name by word boundaries to run token-based analysis
  const tokens = name.split(/([^a-zA-Zа-яА-ЯёЁ0-9])/);

  return (
    <>
      {tokens.map((token, idx) => {
        if (!token || /^[0-9\W_]+$/.test(token)) {
          return <span key={idx}>{token}</span>;
        }

        let latinCount = 0;
        let cyrillicCount = 0;

        for (let i = 0; i < token.length; i++) {
          const code = token.charCodeAt(i);
          if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
            latinCount++;
          } else if (code >= 0x0400 && code <= 0x04ff) {
            // Full Cyrillic block; U+0401 (Ё) and U+0451 (ё) are inside this range already.
            cyrillicCount++;
          }
        }

        if (latinCount === 0 || cyrillicCount === 0) {
          return <span key={idx}>{token}</span>;
        }

        const isPredominantlyLatin = latinCount >= cyrillicCount;
        const chars = [];

        for (let i = 0; i < token.length; i++) {
          const char = token[i]!;
          const code = token.charCodeAt(i);
          const isCyrillic = code >= 0x0400 && code <= 0x04ff;
          const isLatin = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
          const isMinority =
            (isPredominantlyLatin && isCyrillic) || (!isPredominantlyLatin && isLatin);

          if (isMinority) {
            const hex = 'U+' + code.toString(16).toUpperCase().padStart(4, '0');
            const scriptName = isCyrillic ? 'CYRILLIC' : 'LATIN';
            const tooltip = `${char} (${hex} ${scriptName})`;
            chars.push(
              <span key={i} className="homoglyph-char" data-tooltip={tooltip}>
                {char}
              </span>,
            );
          } else {
            chars.push(char);
          }
        }

        return <span key={idx}>{chars}</span>;
      })}
    </>
  );
}

// X из Y title parser
function parseXizY(name: string) {
  const clean = name.replace(/Ё/g, 'Е').replace(/ё/g, 'е');
  // Match "8 из 13"
  const singleMatch = clean.match(/(\d+)\s*(?:из|iz|u3)\s*(\d+)/i);
  if (singleMatch) {
    return {
      x: parseInt(singleMatch[1]!, 10),
      y: parseInt(singleMatch[2]!, 10),
    };
  }
  // Match range "01-16 из 16"
  const rangeMatch = clean.match(/(\d+)-(\d+)\s*(?:из|iz|u3)\s*(\d+)/i);
  if (rangeMatch) {
    const a = parseInt(rangeMatch[1]!, 10);
    const b = parseInt(rangeMatch[2]!, 10);
    return {
      x: b - a + 1,
      y: parseInt(rangeMatch[3]!, 10),
    };
  }
  return null;
}

// Format bytes helper
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Shared centered loading indicator, used in place of a plain "Loading..."
// text node everywhere a view is waiting on its primary query.
function LoadingState({ label }: { label: string }) {
  return (
    <div className="view-body">
      <div className="state-message">
        <Loader2 size={24} className="spin" color="var(--text-dim)" />
        <p style={{ marginTop: '8px' }}>{label}</p>
      </div>
    </div>
  );
}

// Shared centered empty state (icon + heading + description), used by any
// view whose primary list can legitimately be empty.
function EmptyState({
  icon: Icon,
  iconColor,
  title,
  description,
}: {
  icon: React.ComponentType<{ size?: number; color?: string }>;
  iconColor: string;
  title: string;
  description: string;
}) {
  return (
    <div className="state-message">
      <div className="state-message-icon" style={{ backgroundColor: `color-mix(in srgb, ${iconColor} 12%, transparent)` }}>
        <Icon size={28} color={iconColor} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

type TabId = 'queue' | 'labeller' | 'library' | 'health' | 'feed';
const VALID_TABS: TabId[] = ['queue', 'labeller', 'library', 'health', 'feed'];

// Reads the initial tab from ?tab=... so a refresh/bookmark keeps you where
// you were. 'labeller' is deliberately excluded here -- it depends on
// selectedTorrentHash, which isn't itself URL-synced (deep-linking is a
// separate, larger change), so a stale ?tab=labeller would land on an empty
// "select a torrent" view. Falls back to 'queue' in that case.
function getInitialTab(): TabId {
  const param = new URLSearchParams(window.location.search).get('tab');
  if (param && param !== 'labeller' && VALID_TABS.includes(param as TabId)) {
    return param as TabId;
  }
  return 'queue';
}

interface ToastMessage {
  id: number;
  message: string;
  variant: 'success' | 'error';
}

function AdminApp() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabId>(getInitialTab);

  // Keeps the URL's ?tab= param in sync with the active tab (replaceState,
  // not pushState, so tab switches don't spam browser history).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('tab') !== activeTab) {
      params.set('tab', activeTab);
      window.history.replaceState(null, '', `?${params.toString()}`);
    }
  }, [activeTab]);

  // Lightweight toast notifications, replacing alert() for non-destructive
  // mutation results. Destructive actions still use window.confirm() before
  // firing -- toasts are for after-the-fact notice, not confirmation.
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const showToast = (message: string, variant: ToastMessage['variant'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, variant }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  };

  // Navigation index for queue
  const [selectedQueueIdx, setSelectedQueueIdx] = useState<number>(0);

  // Selected torrent for Labeller
  const [selectedTorrentHash, setSelectedTorrentHash] = useState<string | null>(null);
  // Set when the Labeller was opened to edit an already-mapped rule from the
  // Library view, rather than to create a fresh one from the Queue.
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  // Where Cancel/Save should send the user back to -- Queue for a fresh
  // rule, Library for an edit of an existing one.
  const [returnTab, setReturnTab] = useState<'queue' | 'library'>('queue');

  // Queries
  const { data: queue = [], isLoading: isQueueLoading } = useQuery({
    queryKey: ['queue'],
    queryFn: () => apiFetch<QueueItem[]>('/api/queue'),
  });

  const { data: library = [], isLoading: isLibraryLoading } = useQuery({
    queryKey: ['library'],
    queryFn: () => apiFetch<LibraryItem[]>('/api/library'),
  });

  const { data: health, isLoading: isHealthLoading } = useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch<HealthData>('/api/health'),
    refetchInterval: 10000,
  });

  const { data: activity = [], isLoading: isActivityLoading } = useQuery({
    queryKey: ['activity'],
    queryFn: () => apiFetch<ActivityEntry[]>('/api/activity?limit=50'),
    refetchInterval: 10000,
  });

  const { data: torrentDetails, isLoading: isDetailsLoading } = useQuery({
    queryKey: ['torrentDetails', selectedTorrentHash],
    queryFn: () => apiFetch<TorrentDetails>(`/api/torrents/${selectedTorrentHash}`),
    enabled: !!selectedTorrentHash,
  });

  const { data: feed = [], isLoading: isFeedLoading } = useQuery({
    queryKey: ['feed'],
    queryFn: () => apiFetch<FeedItem[]>('/api/feed?limit=200'),
  });

  const downloadFeedEntry = useMutation({
    mutationFn: (topicId: number) =>
      apiFetch<DownloadFeedEntryResponse>(`/api/feed/${topicId}/download`, { method: 'POST' }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['feed'] });
      if (!result.success) {
        showToast(`Download failed: ${result.error ?? 'unknown error'}`, 'error');
      }
    },
    onError: (err) => {
      showToast(`Download failed: ${err.message}`, 'error');
    },
  });

  const matchFeedEntry = useMutation({
    mutationFn: ({ topicId, titleId }: { topicId: number; titleId: string }) =>
      apiFetch<MatchFeedEntryResponse>(`/api/feed/${topicId}/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titleId }),
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['feed'] });
      if (!result.success) {
        showToast(`Match failed: ${result.error ?? 'unknown error'}`, 'error');
      }
    },
    onError: (err) => {
      showToast(`Match failed: ${err.message}`, 'error');
    },
  });

  // Mutations
  const triggerIngest = useMutation({
    mutationFn: () => apiFetch<IngestRunResult>('/api/ingest/run', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] });
      showToast('Ingest run triggered in the background.');
    },
    onError: (err) => {
      showToast(`Failed to trigger ingest: ${err.message}`, 'error');
    },
  });

  const saveRule = useMutation({
    mutationFn: (body: SaveRuleBody) =>
      apiFetch<SaveRuleResponse>('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: ['torrentDetails'] });
      setSelectedTorrentHash(null);
      setEditingRuleId(null);
      setActiveTab(returnTab);
    },
    onError: (err) => {
      showToast(`Failed to save rule: ${err.message}`, 'error');
    },
  });

  // Manual Library entry -- add a title with no torrent/rule attached, or
  // edit an existing one's name/year/poster/provider ids (the Library
  // view's "Add Title" button and each card's "Edit" action).
  const [titleModal, setTitleModal] = useState<
    { mode: 'add' } | { mode: 'edit'; title: TitleRecord } | null
  >(null);

  const createTitle = useMutation({
    mutationFn: (body: TitleFormBody) =>
      apiFetch<TitleMutationResponse>('/api/titles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      showToast(`Added "${result.title.nameRu}" to the Library.`);
      setTitleModal(null);
    },
    onError: (err) => {
      showToast(`Failed to add title: ${err.message}`, 'error');
    },
  });

  const updateTitleMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: TitleFormBody }) =>
      apiFetch<TitleMutationResponse>(`/api/titles/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      showToast(`Updated "${result.title.nameRu}".`);
      setTitleModal(null);
    },
    onError: (err) => {
      showToast(`Failed to update title: ${err.message}`, 'error');
    },
  });

  const deleteTorrent = useMutation({
    mutationFn: (hash: string) => apiFetch<{ success: boolean }>(`/api/torrents/${hash}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] });
      showToast('Torrent deleted.');
    },
    onError: (err) => {
      showToast(`Delete failed: ${err.message}`, 'error');
    },
  });

  const purgeGoneTorrents = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean; deletedCount: number }>('/api/torrents/purge-gone', {
        method: 'POST',
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['health'] });
      showToast(`Deleted ${result.deletedCount} gone torrent${result.deletedCount === 1 ? '' : 's'}.`);
    },
    onError: (err) => {
      showToast(`Purge failed: ${err.message}`, 'error');
    },
  });

  // Keyboard navigation listener in Queue
  useEffect(() => {
    if (activeTab !== 'queue' || queue.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          setSelectedQueueIdx((prev) => Math.min(prev + 1, queue.length - 1));
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          setSelectedQueueIdx((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter': {
          e.preventDefault();
          const item = queue[selectedQueueIdx];
          if (item) {
            setSelectedTorrentHash(item.hash);
            setActiveTab('labeller');
          }
          break;
        }
        case 'a': {
          e.preventDefault();
          // Quick accept proposal
          const target = queue[selectedQueueIdx];
          if (target && target.proposal) {
            if (!target.proposal.titleId) {
              // No resolved title match to accept -- expandRule requires
              // one, so there's nothing safe to save from here. Send the
              // human to the Labeller to resolve the title first instead
              // of fabricating a bare-name title that can never stream.
              showToast(
                'No confirmed title match yet for this proposal -- open the Labeller to resolve one.',
                'error',
              );
              break;
            }
            const accept = window.confirm(
              `Quick-accept proposal: "${target.proposal.title?.nameRu ?? target.proposal.proposedTitle}" (Season ${target.proposal.proposedSeason})?`,
            );
            if (accept) {
              // Reuse the server's own proposal verbatim (numbering/sort/
              // startEpisode/absoluteOffset/exceptions, and the already-
              // resolved titleId) instead of guessing -- for an LLM
              // proposal that's 'manual' numbering plus a per-file
              // exceptions map, not the 'sequential' default this used to
              // hardcode.
              saveRule.mutate({
                torrentHash: target.hash,
                season: target.proposal.proposedSeason,
                numbering: target.proposal.numbering,
                sort: target.proposal.sort,
                startEpisode: target.proposal.startEpisode,
                absoluteOffset: target.proposal.absoluteOffset,
                exceptions: target.proposal.exceptions,
                titleId: target.proposal.titleId,
              });
            }
          }
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab, queue, selectedQueueIdx, saveRule]);

  return (
    <div className="app-container">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-brand-mark">
            <Box size={16} />
          </div>
          <div className="sidebar-header-text">
            <h1>TorBox RU Addon</h1>
            <span>Self-hosted Russian TV Mapper</span>
          </div>
        </div>

        <div className="sidebar-menu">
          <button
            className={`sidebar-item ${activeTab === 'queue' ? 'active' : ''}`}
            onClick={() => setActiveTab('queue')}
          >
            <List size={16} />
            Queue
            {queue.length > 0 && (
              <span className="badge neutral" style={{ marginLeft: 'auto' }}>
                {queue.length}
              </span>
            )}
          </button>
          <button
            className={`sidebar-item ${activeTab === 'labeller' ? 'active' : ''}`}
            onClick={() => {
              if (selectedTorrentHash) {
                setActiveTab('labeller');
              } else {
                showToast('Please select a torrent from the Queue first.', 'error');
              }
            }}
          >
            <Tag size={16} />
            Labeller
          </button>
          <button
            className={`sidebar-item ${activeTab === 'library' ? 'active' : ''}`}
            onClick={() => setActiveTab('library')}
          >
            <FolderOpen size={16} />
            Library
          </button>
          <button
            className={`sidebar-item ${activeTab === 'health' ? 'active' : ''}`}
            onClick={() => setActiveTab('health')}
          >
            <Activity size={16} />
            Health Status
          </button>
          <button
            className={`sidebar-item ${activeTab === 'feed' ? 'active' : ''}`}
            onClick={() => setActiveTab('feed')}
          >
            <Rss size={16} />
            RuTracker Feed
            {feed.filter((f) => !f.downloadedAt).length > 0 && (
              <span className="badge neutral" style={{ marginLeft: 'auto' }}>
                {feed.filter((f) => !f.downloadedAt).length}
              </span>
            )}
          </button>
        </div>

        <div className="sidebar-footer">
          <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>v0.1.0 • ARM64</span>
          {health?.lastIngestRun && (
            <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
              Ingested{' '}
              {new Date(health.lastIngestRun).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="main-content">
        {activeTab === 'queue' && (
          <QueueView
            queue={queue}
            isLoading={isQueueLoading}
            selectedIdx={selectedQueueIdx}
            setSelectedIdx={setSelectedQueueIdx}
            onSelect={(hash) => {
              setSelectedTorrentHash(hash);
              setEditingRuleId(null);
              setReturnTab('queue');
              setActiveTab('labeller');
            }}
            triggerIngest={triggerIngest}
            lastIngestRun={health?.lastIngestRun ?? null}
          />
        )}

        {activeTab === 'labeller' && (
          <LabellerView
            key={selectedTorrentHash}
            hash={selectedTorrentHash}
            details={torrentDetails}
            isLoading={isDetailsLoading}
            saveRule={saveRule}
            initialRuleId={editingRuleId}
            onCancel={() => {
              setSelectedTorrentHash(null);
              setEditingRuleId(null);
              setActiveTab(returnTab);
            }}
          />
        )}

        {activeTab === 'library' && (
          <LibraryView
            library={library}
            isLoading={isLibraryLoading}
            onEditRule={(torrentHash, ruleId) => {
              setSelectedTorrentHash(torrentHash);
              setEditingRuleId(ruleId);
              setReturnTab('library');
              setActiveTab('labeller');
            }}
            onAddTitle={() => setTitleModal({ mode: 'add' })}
            onEditTitle={(title) => setTitleModal({ mode: 'edit', title })}
          />
        )}

        {activeTab === 'health' && (
          <HealthView
            health={health}
            isLoading={isHealthLoading}
            triggerIngest={triggerIngest}
            deleteTorrent={deleteTorrent}
            purgeGoneTorrents={purgeGoneTorrents}
            activity={activity}
            isActivityLoading={isActivityLoading}
          />
        )}

        {activeTab === 'feed' && (
          <FeedView
            feed={feed}
            isLoading={isFeedLoading}
            downloadFeedEntry={downloadFeedEntry}
            matchFeedEntry={matchFeedEntry}
            library={library}
          />
        )}
      </div>

      {/* Add/Edit Title modal (Library view) */}
      {titleModal && (
        <TitleFormModal
          mode={titleModal.mode}
          initial={titleModal.mode === 'edit' ? titleModal.title : null}
          isSubmitting={createTitle.isPending || updateTitleMutation.isPending}
          onClose={() => setTitleModal(null)}
          onSubmit={(body) => {
            if (titleModal.mode === 'add') {
              createTitle.mutate(body);
            } else {
              updateTitleMutation.mutate({ id: titleModal.title.id, body });
            }
          }}
        />
      )}

      {/* Toasts */}
      <div className="toast-container">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.variant}`}>
            {t.variant === 'success' ? (
              <CheckCircle size={16} color="var(--accent-success)" />
            ) : (
              <AlertTriangle size={16} color="var(--accent-danger)" />
            )}
            <span style={{ flex: 1 }}>{t.message}</span>
            <button
              className="icon-btn"
              style={{ border: 'none', background: 'transparent', padding: 2 }}
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- QUEUE VIEW ---
interface QueueViewProps {
  queue: QueueItem[];
  isLoading: boolean;
  selectedIdx: number;
  setSelectedIdx: (idx: number) => void;
  onSelect: (hash: string) => void;
  triggerIngest: UseMutationResult<IngestRunResult, Error, void>;
  lastIngestRun: string | null;
}
function QueueView({
  queue,
  isLoading,
  selectedIdx,
  setSelectedIdx,
  onSelect,
  triggerIngest,
  lastIngestRun,
}: QueueViewProps) {
  const [filter, setFilter] = useState('');

  // Filter while preserving each item's index into the full `queue` array,
  // so selectedIdx (driven by AdminApp's j/k keyboard nav over the
  // unfiltered list) still points at the right row.
  const normalisedFilter = filter.trim().toLowerCase();
  const filteredQueue =
    normalisedFilter.length === 0
      ? queue.map((item, idx) => ({ item, idx }))
      : queue
          .map((item, idx) => ({ item, idx }))
          .filter(({ item }) => item.rawNameAtIngest.toLowerCase().includes(normalisedFilter));

  const header = (
    <div className="view-header">
      <h2>Ingested Review Queue</h2>
      <div className="view-header-actions">
        <div style={{ position: 'relative' }}>
          <Search
            size={14}
            color="var(--text-dim)"
            style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)' }}
          />
          <input
            type="text"
            placeholder="Filter by name..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="filter-input"
            style={{ paddingLeft: '28px' }}
          />
        </div>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Use <kbd>j</kbd>/<kbd>k</kbd> to navigate, <kbd>Enter</kbd> to open, <kbd>a</kbd> to
          quick-approve
        </span>
        <div className="view-header-meta">
          <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
            {lastIngestRun
              ? `Last run: ${new Date(lastIngestRun).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}`
              : 'Never ingested'}
          </span>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => triggerIngest.mutate()}
          disabled={triggerIngest.isPending}
        >
          {triggerIngest.isPending ? 'Ingesting...' : 'Trigger Ingest Run Now'}
        </button>
      </div>
    </div>
  );

  if (isLoading) {
    return (
      <>
        {header}
        <LoadingState label="Loading queue..." />
      </>
    );
  }

  if (queue.length === 0) {
    return (
      <>
        {header}
        <div className="view-body">
          <EmptyState
            icon={CheckCircle}
            iconColor="var(--accent-success)"
            title="All caught up!"
            description="There are no active torrents awaiting review."
          />
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="view-body">
        {filteredQueue.length === 0 ? (
          <p className="panel-empty">No torrents match "{filter}".</p>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Torrent Name</th>
                  <th className="col-narrow col-center">Files</th>
                  <th>Proposed Show Mapping</th>
                  <th className="col-narrow col-center">Season</th>
                  <th className="col-narrow col-center">Conf.</th>
                  <th style={{ width: '60px' }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredQueue.map(({ item, idx }) => (
                  <tr
                    key={item.hash}
                    className={`${idx === selectedIdx ? 'selected navigating' : ''}`}
                    onClick={() => setSelectedIdx(idx)}
                    onDoubleClick={() => onSelect(item.hash)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td
                      className="mono"
                      style={{
                        maxWidth: '400px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {highlightHomoglyphs(item.rawNameAtIngest)}
                    </td>
                    <td className="col-center">{item.fileCount}</td>
                    <td>{item.proposal?.proposedTitle || '-'}</td>
                    <td className="col-center">{item.proposal?.proposedSeason ?? '-'}</td>
                    <td className="col-center">
                      <span
                        className={`badge ${
                          item.proposal?.confidence >= 0.8
                            ? 'success'
                            : item.proposal?.confidence >= 0.4
                              ? 'attention'
                              : 'danger'
                        }`}
                      >
                        {(item.proposal?.confidence * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '4px 8px', fontSize: '11px' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(item.hash);
                        }}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// --- LABELLER VIEW ---
interface LabellerViewProps {
  hash: string | null;
  details: TorrentDetails | undefined;
  isLoading: boolean;
  saveRule: UseMutationResult<SaveRuleResponse, Error, SaveRuleBody>;
  // The rule being edited (from the Library view), if any -- null for a
  // fresh rule started from the Queue.
  initialRuleId: string | null;
  onCancel: () => void;
}
function LabellerView({
  hash,
  details,
  isLoading,
  saveRule,
  initialRuleId,
  onCancel,
}: LabellerViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<TmdbSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedShow, setSelectedShow] = useState<SelectedShowInfo | null>(null);
  // Guards the details -> season/searchQuery initial-fill below so it only
  // runs once per mount (LabellerView is remounted via `key={hash}` in the
  // parent whenever the selected torrent changes, so this doesn't need to
  // reset on its own).
  const [initialized, setInitialized] = useState(false);

  // Form State
  const [season, setSeason] = useState(1);
  const [numberingMode, setNumberingMode] = useState<
    'sequential' | 'parsed' | 'continuous' | 'manual'
  >('sequential');
  const [sortMode, setSortMode] = useState<'natural' | 'path'>('natural');
  const [startEpisode, setStartEpisode] = useState(1);
  const [absoluteOffset, setAbsoluteOffset] = useState<number | null>(null);

  // exceptions map: record of fileId (string) to Exception value
  const [exceptions, setExceptions] = useState<Record<string, RuleException>>({});

  // Last "Preview with AI" result, shown as a reasoning/confidence banner
  // above the (already-existing) live preview table below -- cleared
  // whenever a fresh preview is requested so a stale reasoning string never
  // lingers next to hand-edited state.
  const [lastPreview, setLastPreview] = useState<PreviewResponse | null>(null);

  // Runs the LLM extraction for this one torrent on demand and populates
  // the same form state a human would fill in by hand -- nothing is
  // persisted until Save is clicked (POST /api/torrents/:hash/preview does
  // not write a rule or mappings). The live preview table below re-renders
  // automatically from this state change, same as any manual edit.
  const previewWithAi = useMutation({
    mutationFn: () =>
      apiFetch<PreviewResponse>(`/api/torrents/${hash}/preview`, { method: 'POST' }),
    onSuccess: (data) => {
      setLastPreview(data);
      setSeason(data.proposal.season);
      setNumberingMode(data.proposal.numbering);
      setSortMode(data.proposal.sort);
      setStartEpisode(data.proposal.startEpisode);
      setAbsoluteOffset(data.proposal.absoluteOffset);
      setExceptions(data.proposal.exceptions);
      setSelectedShow(
        data.title
          ? {
              titleId: data.title.id,
              tmdbId: data.title.tmdbId,
              nameRu: data.title.nameRu,
              nameEn: data.title.nameEn,
              year: data.title.year,
              posterUrl: data.title.posterUrl,
            }
          : null,
      );
    },
    onError: (err) => {
      setLastPreview(null);
      alert(`AI preview failed: ${err.message}`);
    },
  });

  // Handle Search Trigger
  const triggerSearch = async (query: string) => {
    if (!query) return;
    setIsSearching(true);
    try {
      const results = await apiFetch<TmdbSearchResult[]>(
        `/api/titles/search?query=${encodeURIComponent(query)}`,
      );
      setSearchResults(results);
    } catch (err) {
      console.error(err);
    } finally {
      setIsSearching(false);
    }
  };

  if (isLoading || !details) return <LoadingState label="Loading files details..." />;

  const editingRule = initialRuleId ? details.rules.find((r) => r.id === initialRuleId) : undefined;

  // Fill the form once, the first time `details` becomes available
  // (adjusting state during render instead of in an effect -- see
  // https://react.dev/learn/you-might-not-need-an-effect): from the
  // existing rule if we're editing one, otherwise auto-fill a proposed
  // season/search query from the torrent name for a fresh rule.
  if (!initialized) {
    if (editingRule) {
      setSeason(editingRule.season);
      setNumberingMode(editingRule.numbering);
      setSortMode(editingRule.sort);
      setStartEpisode(editingRule.startEpisode);
      setAbsoluteOffset(editingRule.absoluteOffset);
      setExceptions(editingRule.exceptions);
      setSelectedShow({
        titleId: editingRule.title.id,
        tmdbId: editingRule.title.tmdbId,
        nameRu: editingRule.title.nameRu,
        nameEn: editingRule.title.nameEn,
        year: editingRule.title.year,
        posterUrl: editingRule.title.posterUrl,
      });
    } else {
      const name = details.rawNameAtIngest.replace(/\[.*?\]/g, '').trim();
      const seasonMatch = name.match(/(\d+)\s*(сезон|season)/i);
      let initialSeason = season;
      let initialQuery = name;
      if (seasonMatch && seasonMatch[1]) {
        initialSeason = parseInt(seasonMatch[1], 10);
        initialQuery = name.replace(seasonMatch[0], '').trim();
      }
      setSeason(initialSeason);
      setSearchQuery(initialQuery);
    }
    setInitialized(true);
  }

  const videoFiles = details.files.filter((f) => f.isVideo);
  const totalVideoFilesCount = videoFiles.length;

  // Local rule representation for Client-Side expandRule preview
  const rule: Rule = {
    id: 'preview-rule',
    torrentHash: hash || '',
    titleId: selectedShow?.tmdbId ? String(selectedShow.tmdbId) : 'placeholder-title',
    season,
    numbering: numberingMode,
    sort: sortMode,
    startEpisode,
    absoluteOffset,
    exceptions,
    confidence: 1.0,
    source: 'manual',
    proposalReason: null,
    torrentName: details.rawNameAtIngest,
  };

  // Convert files to RuleFile schema shape
  const ruleFiles: RuleFile[] = videoFiles.map((f) => ({
    id: f.id,
    path: f.rawPath,
    isVideo: f.isVideo,
  }));

  // Client-side execution of expandRule
  let previewMappings: Mapping[] = [];
  let previewError: string | null = null;
  try {
    previewMappings = expandRule(rule, ruleFiles);
  } catch (err) {
    previewError = err instanceof Error ? err.message : 'Error executing rule preview.';
  }

  // Validate X из Y
  const xizY = parseXizY(details.rawNameAtIngest);
  const ignoredCount = Object.values(exceptions).filter((v) => v === 'ignore').length;
  const activeFilesCount = totalVideoFilesCount - ignoredCount;

  const fileCountWarning = xizY && activeFilesCount !== xizY.x;

  const handleSubmit = () => {
    if (!hash) return;
    if (!selectedShow) {
      alert('Please search and select a TMDB Show mapping.');
      return;
    }

    saveRule.mutate({
      ruleId: initialRuleId ?? undefined,
      torrentHash: hash,
      season,
      numbering: numberingMode,
      sort: sortMode,
      startEpisode,
      absoluteOffset,
      exceptions,
      // A titleId carried over from editing (show unchanged) skips
      // re-resolving external ids from TMDB server-side; picking a
      // different show via search always goes through `title` instead,
      // same as a fresh rule.
      ...(selectedShow.titleId
        ? { titleId: selectedShow.titleId }
        : {
            title: {
              tmdbId: selectedShow.tmdbId,
              nameRu: selectedShow.nameRu,
              nameEn: selectedShow.nameEn,
              year: selectedShow.year,
              posterUrl: selectedShow.posterUrl,
            },
          }),
    });
  };

  const setException = (fileId: number, value: 'none' | 'ignore' | 'custom', customEp?: number) => {
    setExceptions((prev) => {
      const copy = { ...prev };
      if (value === 'none') {
        delete copy[String(fileId)];
      } else if (value === 'ignore') {
        copy[String(fileId)] = 'ignore';
      } else if (value === 'custom' && customEp !== undefined) {
        copy[String(fileId)] = { season, episode: customEp };
      }
      return copy;
    });
  };

  return (
    <>
      <div className="view-header">
        <h2>
          Manual Mapping Labeller
          {editingRule && (
            <span className="badge info" style={{ marginLeft: '8px' }}>
              Editing S{editingRule.season}
            </span>
          )}
        </h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => previewWithAi.mutate()}
            disabled={previewWithAi.isPending || !hash}
            title="Runs the LLM extraction for this torrent and fills in the fields below for review -- nothing is saved until you click Save."
          >
            {previewWithAi.isPending ? 'Asking the LLM… (can take up to a minute)' : 'Preview with AI'}
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={saveRule.isPending}>
            {saveRule.isPending
              ? 'Saving...'
              : editingRule
                ? 'Update Rule & Mappings'
                : 'Save Rule & Mappings'}
          </button>
        </div>
      </div>

      <div className="view-body">
        {/* AI preview result -- what the LLM proposed and why, cleared on
            the next preview request. Purely informational; every field it
            populated above is still freely editable before Save. */}
        {lastPreview && (
          <div className={`banner ${lastPreview.tier === 'commit' ? 'success' : 'attention'}`}>
            {lastPreview.tier === 'commit' ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
            <span>
              <strong>AI preview ({lastPreview.tier === 'commit' ? 'confident' : 'needs review'}):</strong>{' '}
              {lastPreview.reasoning}
            </span>
          </div>
        )}

        {/* Validation Banners */}
        {xizY && (
          <div className={`banner ${fileCountWarning ? 'attention' : 'success'}`}>
            {fileCountWarning ? (
              <>
                <AlertTriangle size={16} />
                <span>
                  <strong>File Count Warning:</strong> Torrent name declares{' '}
                  <strong>
                    {xizY.x} из {xizY.y}
                  </strong>
                  , but there are <strong>{activeFilesCount}</strong> active video files (excluding
                  ignored ones).
                </span>
              </>
            ) : (
              <>
                <CheckCircle size={16} />
                <span>
                  Torrent declares <strong>{xizY.x}</strong> episodes present. Matches active video
                  file count exactly.
                </span>
              </>
            )}
          </div>
        )}

        <div className="labeller-grid">
          {/* Left Pane - Ingest Details & Files */}
          <div className="labeller-pane">
            <div className="pane-header">
              <span>Ingested Files ({totalVideoFilesCount} video)</span>
              <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {hash?.substring(0, 8)}
              </span>
            </div>
            <div
              className="pane-body"
              style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
            >
              <div
                style={{
                  backgroundColor: 'var(--bg-main)',
                  padding: '12px',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                }}
              >
                <span
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-muted)',
                    display: 'block',
                    marginBottom: '4px',
                  }}
                >
                  Raw Torrent Name
                </span>
                <div className="mono" style={{ fontSize: '13px', lineBreak: 'anywhere' }}>
                  {highlightHomoglyphs(details.rawNameAtIngest)}
                </div>
              </div>

              <div style={{ flex: 1, overflowY: 'auto' }}>
                <table style={{ minWidth: '100%' }}>
                  <thead>
                    <tr>
                      <th>Filename</th>
                      <th style={{ width: '80px', textAlign: 'right' }}>Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {videoFiles.map((file) => (
                      <tr key={file.id}>
                        <td className="mono" style={{ fontSize: '12px', wordBreak: 'break-all' }}>
                          {highlightHomoglyphs(file.rawPath)}
                        </td>
                        <td
                          style={{
                            textAlign: 'right',
                            fontSize: '11px',
                            color: 'var(--text-muted)',
                          }}
                        >
                          {formatBytes(file.size)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Right Pane - Rules Configuration */}
          <div className="labeller-pane">
            <div className="pane-header">
              <span>Mapping Parameters</span>
              {selectedShow?.tmdbId && (
                <span className="badge info">TMDB: {selectedShow.tmdbId}</span>
              )}
            </div>
            <div
              className="pane-body"
              style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
            >
              {/* Show Picker Search */}
              <div className="form-group" style={{ position: 'relative' }}>
                <label>Find TMDB Series</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    placeholder="Search Cyrillic or English..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && triggerSearch(searchQuery)}
                  />
                  <button className="btn btn-secondary" onClick={() => triggerSearch(searchQuery)}>
                    {isSearching ? (
                      <RefreshCw className="animate-spin" size={16} />
                    ) : (
                      <Search size={16} />
                    )}
                  </button>
                </div>

                {/* Show Search Autocomplete Drawer */}
                {searchResults.length > 0 && (
                  <div className="dropdown-panel">
                    {searchResults.map((show) => (
                      <div
                        key={show.tmdbId}
                        className="dropdown-panel-item"
                        onClick={() => {
                          // A fresh pick from search, never a stale
                          // titleId from whatever was previously selected
                          // (e.g. when editing and switching to a
                          // different show) -- the server resolves/creates
                          // the title from tmdbId instead.
                          setSelectedShow({
                            tmdbId: show.tmdbId,
                            nameRu: show.nameRu,
                            nameEn: show.nameEn,
                            year: show.year,
                            posterUrl: show.posterUrl,
                          });
                          setSearchResults([]);
                        }}
                      >
                        {show.posterUrl ? (
                          <img
                            src={show.posterUrl}
                            alt=""
                            style={{
                              width: '30px',
                              height: '45px',
                              objectFit: 'cover',
                              borderRadius: '4px',
                            }}
                          />
                        ) : (
                          <div
                            style={{
                              width: '30px',
                              height: '45px',
                              backgroundColor: 'var(--bg-main)',
                              borderRadius: '4px',
                            }}
                          />
                        )}
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: 600 }}>{show.nameRu}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            {show.nameEn} {show.year ? `(${show.year})` : ''}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Show selected metadata card */}
              {selectedShow && (
                <div className="meta-card">
                  {selectedShow.posterUrl && (
                    <img
                      src={selectedShow.posterUrl}
                      alt=""
                      style={{
                        width: '50px',
                        height: '75px',
                        objectFit: 'cover',
                        borderRadius: '4px',
                      }}
                    />
                  )}
                  <div>
                    <h4 style={{ margin: '0 0 4px 0', fontSize: '14px', fontWeight: 600 }}>
                      {selectedShow.nameRu}
                    </h4>
                    <p style={{ margin: '0', fontSize: '12px', color: 'var(--text-muted)' }}>
                      Original: {selectedShow.nameEn}
                    </p>
                    <p style={{ margin: '0', fontSize: '12px', color: 'var(--text-muted)' }}>
                      Year: {selectedShow.year ?? 'N/A'}
                    </p>
                  </div>
                  <button
                    className="btn btn-secondary"
                    style={{ marginLeft: 'auto', alignSelf: 'center', padding: '6px' }}
                    onClick={() => setSelectedShow(null)}
                  >
                    Clear
                  </button>
                </div>
              )}

              {/* Controls layout */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div className="form-group">
                  <label>Season</label>
                  <input
                    type="number"
                    min={1}
                    value={season}
                    onChange={(e) => setSeason(parseInt(e.target.value, 10) || 1)}
                  />
                </div>
                <div className="form-group">
                  <label>Numbering Mode</label>
                  <select
                    value={numberingMode}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                      setNumberingMode(
                        e.target.value as 'sequential' | 'parsed' | 'continuous' | 'manual',
                      )
                    }
                  >
                    <option value="sequential">sequential</option>
                    <option value="continuous">continuous</option>
                    <option value="manual">manual</option>
                    <option value="parsed">parsed</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Sort Mode</label>
                  <select
                    value={sortMode}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                      setSortMode(e.target.value as 'natural' | 'path')
                    }
                  >
                    <option value="natural">natural</option>
                    <option value="path">path</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Start Episode</label>
                  <input
                    type="number"
                    min={1}
                    value={startEpisode}
                    onChange={(e) => setStartEpisode(parseInt(e.target.value, 10) || 1)}
                  />
                </div>
                {numberingMode === 'continuous' && (
                  <div className="form-group">
                    <label>Absolute Offset</label>
                    <input
                      type="number"
                      value={absoluteOffset ?? ''}
                      placeholder="e.g. 12"
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        setAbsoluteOffset(isNaN(val) ? null : val);
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Live Preview Table */}
        <div
          style={{
            marginTop: '24px',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            overflow: 'hidden',
            backgroundColor: 'var(--bg-surface)',
          }}
        >
          <div className="pane-header">
            <span>Client-Side Live Preview (`expandRule` Run)</span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Updates instantly as rule settings or overrides change
            </span>
          </div>

          <div style={{ padding: '16px', overflowX: 'auto' }}>
            {previewError ? (
              <div style={{ color: 'var(--accent-danger)', padding: '12px', fontSize: '13px' }}>
                <strong>Preview Error:</strong> {previewError}
              </div>
            ) : (
              <table style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Filename</th>
                    <th style={{ width: '120px', textAlign: 'center' }}>Resolved Episode</th>
                    <th style={{ width: '220px', textAlign: 'right' }}>Exception Override</th>
                  </tr>
                </thead>
                <tbody>
                  {videoFiles.map((file) => {
                    const resolvedMapping = previewMappings.find((m) => m.fileId === file.id);
                    const exceptionVal = exceptions[String(file.id)];

                    return (
                      <tr key={file.id}>
                        <td className="mono" style={{ fontSize: '12px' }}>
                          {highlightHomoglyphs(file.rawPath)}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 'bold' }}>
                          {resolvedMapping ? (
                            <span className="mono" style={{ color: 'var(--accent-info)' }}>
                              S{String(resolvedMapping.season).padStart(2, '0')}E
                              {String(resolvedMapping.episode).padStart(2, '0')}
                            </span>
                          ) : exceptionVal === 'ignore' ? (
                            <span className="badge neutral">IGNORED</span>
                          ) : (
                            <span style={{ color: 'var(--text-dim)' }}>-</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', gap: '8px' }}>
                            <select
                              value={
                                exceptionVal === undefined
                                  ? 'none'
                                  : exceptionVal === 'ignore'
                                    ? 'ignore'
                                    : 'custom'
                              }
                              onChange={(e) => {
                                const val = e.target.value;
                                if (val === 'none') setException(file.id, 'none');
                                else if (val === 'ignore') setException(file.id, 'ignore');
                                else setException(file.id, 'custom', 1);
                              }}
                              style={{ width: '100px', padding: '4px' }}
                            >
                              <option value="none">None</option>
                              <option value="ignore">Ignore File</option>
                              <option value="custom">Episode Override</option>
                            </select>

                            {typeof exceptionVal === 'object' && exceptionVal !== null && (
                              <input
                                type="number"
                                min={1}
                                value={exceptionVal.episode}
                                onChange={(e) =>
                                  setException(file.id, 'custom', parseInt(e.target.value, 10) || 1)
                                }
                                style={{ width: '60px', padding: '4px' }}
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// --- ADD/EDIT TITLE MODAL ---
// Lets a human add a Library title by hand (no torrent/rule required) or
// correct an existing one's provider ids -- either by picking a TMDB search
// result, typing any combination of tmdbId/imdbId/tvdbId directly, or a mix
// of both, with a "Resolve IDs" step to preview TMDB's cross-reference
// before saving (see GET /api/titles/resolve, src/metadata/tmdb.ts's
// resolveTitleIds).
interface TitleFormModalProps {
  mode: 'add' | 'edit';
  initial: TitleRecord | null;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (body: TitleFormBody) => void;
}
function TitleFormModal({ mode, initial, isSubmitting, onClose, onSubmit }: TitleFormModalProps) {
  const [nameRu, setNameRu] = useState(initial?.nameRu ?? '');
  const [nameEn, setNameEn] = useState(initial?.nameEn ?? '');
  const [year, setYear] = useState(initial?.year != null ? String(initial.year) : '');
  const [posterUrl, setPosterUrl] = useState(initial?.posterUrl ?? '');
  const [tmdbId, setTmdbId] = useState(initial?.tmdbId != null ? String(initial.tmdbId) : '');
  const [imdbId, setImdbId] = useState(initial?.imdbId ?? '');
  const [tvdbId, setTvdbId] = useState(initial?.tvdbId != null ? String(initial.tvdbId) : '');

  const [searchQuery, setSearchQuery] = useState(initial?.nameRu ?? '');
  const [searchResults, setSearchResults] = useState<TmdbSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isResolving, setIsResolving] = useState(false);

  const triggerSearch = async (query: string) => {
    if (!query) return;
    setIsSearching(true);
    try {
      const results = await apiFetch<TmdbSearchResult[]>(
        `/api/titles/search?query=${encodeURIComponent(query)}`,
      );
      setSearchResults(results);
    } catch (err) {
      console.error(err);
    } finally {
      setIsSearching(false);
    }
  };

  const applySearchResult = (show: TmdbSearchResult) => {
    setNameRu(show.nameRu);
    setNameEn(show.nameEn ?? '');
    setYear(show.year != null ? String(show.year) : '');
    setPosterUrl(show.posterUrl ?? '');
    setTmdbId(String(show.tmdbId));
    setSearchResults([]);
  };

  // Cross-references TMDB from whichever id(s) are currently filled in to
  // preview/backfill the other two plus name/year/poster -- never
  // overwrites a field the human already typed something into, only fills
  // in blanks (matches resolveTitleIds' own "explicit ids always win"
  // behaviour server-side).
  const resolveIds = async () => {
    if (!tmdbId && !imdbId && !tvdbId) {
      alert('Enter at least one of TMDB / IMDb / TVDB id first.');
      return;
    }
    setIsResolving(true);
    try {
      const params = new URLSearchParams();
      if (tmdbId) params.set('tmdbId', tmdbId);
      if (imdbId) params.set('imdbId', imdbId);
      if (tvdbId) params.set('tvdbId', tvdbId);
      const resolved = await apiFetch<ResolvedTitleIds>(`/api/titles/resolve?${params.toString()}`);

      if (!tmdbId && resolved.tmdbId) setTmdbId(String(resolved.tmdbId));
      if (!imdbId && resolved.imdbId) setImdbId(resolved.imdbId);
      if (!tvdbId && resolved.tvdbId) setTvdbId(String(resolved.tvdbId));
      if (!nameRu && resolved.nameRu) setNameRu(resolved.nameRu);
      if (!nameEn && resolved.nameEn) setNameEn(resolved.nameEn);
      if (!year && resolved.year) setYear(String(resolved.year));
      if (!posterUrl && resolved.posterUrl) setPosterUrl(resolved.posterUrl);

      if (!resolved.tmdbId && !resolved.imdbId && !resolved.tvdbId) {
        alert('TMDB had no cross-reference for the id(s) given.');
      }
    } catch (err) {
      alert(`Failed to resolve ids: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsResolving(false);
    }
  };

  const handleSubmit = () => {
    const trimmedNameRu = nameRu.trim();
    if (!trimmedNameRu) {
      alert('Name (RU) is required.');
      return;
    }
    onSubmit({
      nameRu: trimmedNameRu,
      nameEn: nameEn.trim() || null,
      year: year ? Number(year) : null,
      posterUrl: posterUrl.trim() || null,
      tmdbId: tmdbId ? Number(tmdbId) : null,
      imdbId: imdbId.trim() || null,
      tvdbId: tvdbId ? Number(tvdbId) : null,
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{mode === 'add' ? 'Add Title' : `Edit "${initial?.nameRu}"`}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group" style={{ position: 'relative', marginBottom: 0 }}>
            <label>Search TMDB (optional)</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                placeholder="Search Cyrillic or English..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && triggerSearch(searchQuery)}
              />
              <button className="btn btn-secondary" onClick={() => triggerSearch(searchQuery)}>
                {isSearching ? (
                  <RefreshCw className="animate-spin" size={16} />
                ) : (
                  <Search size={16} />
                )}
              </button>
            </div>
            {searchResults.length > 0 && (
              <div className="dropdown-panel">
                {searchResults.map((show) => (
                  <div
                    key={show.tmdbId}
                    className="dropdown-panel-item"
                    onClick={() => applySearchResult(show)}
                  >
                    {show.posterUrl ? (
                      <img
                        src={show.posterUrl}
                        alt=""
                        style={{ width: '30px', height: '45px', objectFit: 'cover', borderRadius: '4px' }}
                      />
                    ) : (
                      <div
                        style={{
                          width: '30px',
                          height: '45px',
                          backgroundColor: 'var(--bg-main)',
                          borderRadius: '4px',
                        }}
                      />
                    )}
                    <div>
                      <div>{show.nameRu}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                        {show.nameEn} {show.year ? `(${show.year})` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="form-group">
            <label>Name (RU) *</label>
            <input type="text" value={nameRu} onChange={(e) => setNameRu(e.target.value)} />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Name (EN)</label>
              <input type="text" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Year</label>
              <input
                type="number"
                value={year}
                onChange={(e) => setYear(e.target.value)}
              />
            </div>
          </div>

          <div className="form-group">
            <label>Poster URL</label>
            <input type="text" value={posterUrl} onChange={(e) => setPosterUrl(e.target.value)} />
          </div>

          <div className="form-row" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
            <div className="form-group">
              <label>TMDB ID</label>
              <input
                type="text"
                inputMode="numeric"
                value={tmdbId}
                onChange={(e) => setTmdbId(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>IMDb ID</label>
              <input
                type="text"
                placeholder="tt1234567"
                value={imdbId}
                onChange={(e) => setImdbId(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>TVDB ID</label>
              <input
                type="text"
                inputMode="numeric"
                value={tvdbId}
                onChange={(e) => setTvdbId(e.target.value)}
              />
            </div>
          </div>

          <div>
            <button
              className="btn btn-secondary"
              onClick={resolveIds}
              disabled={isResolving}
              style={{ width: '100%' }}
            >
              {isResolving ? (
                <>
                  <RefreshCw className="animate-spin" size={14} /> Resolving…
                </>
              ) : (
                'Resolve IDs from TMDB'
              )}
            </button>
            <span className="form-hint">
              Fills in any blank TMDB/IMDb/TVDB id (and name/year/poster) from whichever id(s) above
              are already set -- never overwrites something you've typed in.
            </span>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? 'Saving...' : mode === 'add' ? 'Add Title' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- LIBRARY VIEW ---
interface LibraryViewProps {
  library: LibraryItem[];
  isLoading: boolean;
  onEditRule: (torrentHash: string, ruleId: string) => void;
  onAddTitle: () => void;
  onEditTitle: (title: TitleRecord) => void;
}
function LibraryView({ library, isLoading, onEditRule, onAddTitle, onEditTitle }: LibraryViewProps) {
  const [filter, setFilter] = useState('');

  if (isLoading) return <LoadingState label="Loading library grid..." />;

  const normalisedFilter = filter.trim().toLowerCase();
  const filteredLibrary =
    normalisedFilter.length === 0
      ? library
      : library.filter(
          (show) =>
            show.nameRu.toLowerCase().includes(normalisedFilter) ||
            show.nameEn?.toLowerCase().includes(normalisedFilter),
        );

  return (
    <>
      <div className="view-header">
        <h2>Seeded & Mapped Library</h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <div style={{ position: 'relative' }}>
            <Search
              size={14}
              color="var(--text-dim)"
              style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)' }}
            />
            <input
              type="text"
              placeholder="Filter by show name..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="filter-input"
              style={{ paddingLeft: '28px' }}
            />
          </div>
          <button className="btn btn-primary" onClick={onAddTitle}>
            Add Title
          </button>
        </div>
      </div>
      <div className="view-body">
        {library.length === 0 ? (
          <EmptyState
            icon={FolderOpen}
            iconColor="var(--text-dim)"
            title="Library is empty"
            description='Shows will appear here once torrents in the Queue are mapped, or click "Add Title" above to add one by hand.'
          />
        ) : filteredLibrary.length === 0 ? (
          <p className="panel-empty">No shows match "{filter}".</p>
        ) : (
        <div className="library-grid">
          {filteredLibrary.map((show) => (
            <div key={show.id} className="library-card">
              <div className="library-card-header">
                {show.posterUrl ? (
                  <img src={show.posterUrl} alt="" className="library-card-poster" />
                ) : (
                  <div
                    className="library-card-poster"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: 'var(--bg-surface-elevated)',
                    }}
                  >
                    <FolderOpen size={24} color="var(--text-dim)" />
                  </div>
                )}
                <div className="library-card-title-info" style={{ flex: 1, minWidth: 0 }}>
                  <h3>{show.nameRu}</h3>
                  <span style={{ display: 'block' }}>{show.nameEn}</span>
                  <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{show.year ?? 'N/A'}</span>
                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
                    {show.imdbId ? (
                      <span className="badge neutral" style={{ fontSize: '10px' }}>
                        imdb:{show.imdbId}
                      </span>
                    ) : null}
                    {show.tmdbId ? (
                      <span className="badge neutral" style={{ fontSize: '10px' }}>
                        tmdb:{show.tmdbId}
                      </span>
                    ) : null}
                    {show.tvdbId ? (
                      <span className="badge neutral" style={{ fontSize: '10px' }}>
                        tvdb:{show.tvdbId}
                      </span>
                    ) : null}
                    {!show.imdbId && !show.tmdbId && !show.tvdbId ? (
                      <span className="badge attention" style={{ fontSize: '10px' }}>
                        No Provider ID
                      </span>
                    ) : null}
                  </div>
                </div>
                <button
                  className="icon-btn icon-btn-neutral"
                  style={{ alignSelf: 'flex-start' }}
                  title="Edit name/year/poster and provider ids"
                  onClick={() =>
                    onEditTitle({
                      id: show.id,
                      nameRu: show.nameRu,
                      nameEn: show.nameEn,
                      year: show.year,
                      posterUrl: show.posterUrl,
                      imdbId: show.imdbId,
                      tmdbId: show.tmdbId,
                      tvdbId: show.tvdbId,
                    })
                  }
                >
                  <Pencil size={14} />
                </button>
              </div>

              <div className="library-card-seasons">
                {show.seasons.map((season) => {
                  const totalCount = season.totalEpisodesCount ?? 0;

                  // Build a sparse array representing episode boxes
                  const maxEp = Math.max(
                    totalCount,
                    season.episodes.reduce((max: number, curr) => Math.max(max, curr.episode), 0),
                  );

                  const boxes = [];
                  for (let ep = 1; ep <= maxEp; ep++) {
                    const match = season.episodes.find((e) => e.episode === ep);
                    const state = !match ? 'empty' : match.count > 1 ? 'duplicate' : 'mapped';
                    const tooltipText = !match
                      ? `Episode ${ep} (Missing)`
                      : match.count > 1
                        ? `Episode ${ep} (${match.count} files matched: ${match.files.join(', ')})`
                        : `Episode ${ep} (Matched: ${match.files[0]})`;

                    boxes.push(
                      <div key={ep} className={`episode-box ${state}`} data-tooltip={tooltipText}>
                        {ep}
                      </div>,
                    );
                  }

                  return (
                    <div
                      key={season.seasonNumber}
                      style={{
                        borderBottom: '1px solid rgba(255,255,255,0.03)',
                        paddingBottom: '8px',
                      }}
                    >
                      <div className="season-row">
                        <strong>Season {season.seasonNumber}</strong>
                        <span style={{ color: 'var(--text-muted)' }}>
                          {season.mappedEpisodesCount} / {season.totalEpisodesCount ?? '?'} ep
                        </span>
                      </div>
                      <div className="episode-grid">{boxes}</div>
                      {season.rules.length > 0 && (
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '4px',
                            marginTop: '8px',
                          }}
                        >
                          {season.rules.map((rule) => (
                            <div
                              key={rule.id}
                              style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                            >
                              <span
                                className="mono"
                                style={{ fontSize: '11px', color: 'var(--text-dim)' }}
                              >
                                {rule.torrentHash.substring(0, 8)}
                              </span>
                              <span className="badge neutral" style={{ fontSize: '10px' }}>
                                {rule.numbering}
                              </span>
                              <button
                                className="btn btn-secondary"
                                style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: '11px' }}
                                onClick={() => onEditRule(rule.torrentHash, rule.id)}
                              >
                                Edit
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        )}
      </div>
    </>
  );
}

// --- HEALTH VIEW ---
interface HealthViewProps {
  health: HealthData | undefined;
  isLoading: boolean;
  triggerIngest: UseMutationResult<IngestRunResult, Error, void>;
  deleteTorrent: UseMutationResult<{ success: boolean }, Error, string>;
  purgeGoneTorrents: UseMutationResult<{ success: boolean; deletedCount: number }, Error, void>;
  activity: ActivityEntry[];
  isActivityLoading: boolean;
}
function HealthView({
  health,
  isLoading,
  triggerIngest,
  deleteTorrent,
  purgeGoneTorrents,
  activity,
  isActivityLoading,
}: HealthViewProps) {
  if (isLoading || !health) return <LoadingState label="Loading health statistics..." />;

  return (
    <>
      <div className="view-header">
        <h2>System Health Dashboard</h2>
        <button
          className="btn btn-primary"
          onClick={() => triggerIngest.mutate()}
          disabled={triggerIngest.isPending}
        >
          {triggerIngest.isPending ? 'Ingesting...' : 'Trigger Ingest Run Now'}
        </button>
      </div>

      <div className="view-body" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {/* Row of stats cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
          <div className="stat-card">
            <div className="stat-card-icon stat-card-icon-info">
              <Clock size={20} />
            </div>
            <div>
              <span className="stat-card-label">Last Ingest Run</span>
              <strong className="stat-card-value">
                {health.lastIngestRun
                  ? new Date(health.lastIngestRun).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : 'Never'}
              </strong>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-card-icon stat-card-icon-danger">
              <AlertTriangle size={20} />
            </div>
            <div>
              <span className="stat-card-label">Gone Torrents</span>
              <strong className="stat-card-value">{health.goneCount}</strong>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-card-icon stat-card-icon-attention">
              <Database size={20} />
            </div>
            <div>
              <span className="stat-card-label">Dangling Mappings</span>
              <strong className="stat-card-value">{health.danglingMappings}</strong>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-card-icon stat-card-icon-neutral">
              <FileText size={20} />
            </div>
            <div>
              <span className="stat-card-label">Files w/o Mount Path</span>
              <strong className="stat-card-value">{health.filesNoMountPath}</strong>
            </div>
          </div>
        </div>

        {/* Gone list & Play log split */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px' }}>
          {/* Gone List */}
          <div className="panel">
            <div className="panel-header">
              <h3>Gone Torrents Audit (Recent 10)</h3>
              <button
                className="btn btn-danger"
                style={{ padding: '4px 10px', fontSize: '11px' }}
                disabled={health.goneCount === 0 || purgeGoneTorrents.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete all ${health.goneCount} gone torrent${health.goneCount === 1 ? '' : 's'} from the database? This cannot be undone (TorBox itself is unaffected).`,
                    )
                  ) {
                    purgeGoneTorrents.mutate();
                  }
                }}
              >
                {purgeGoneTorrents.isPending ? 'Deleting...' : `Delete All Gone (${health.goneCount})`}
              </button>
            </div>
            {health.goneTorrents.length === 0 ? (
              <p className="panel-empty">No gone torrents recorded.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {health.goneTorrents.map((t) => (
                  <div key={t.hash} className="list-item">
                    <div className="list-item-main">
                      <div className="mono list-item-title">{t.name}</div>
                      <div className="list-item-meta">
                        Last seen: {new Date(t.lastSeen).toLocaleString()}
                      </div>
                    </div>
                    <button
                      className="icon-btn"
                      title="Delete this torrent from the database"
                      disabled={deleteTorrent.isPending}
                      onClick={() => {
                        if (window.confirm(`Delete "${t.name}" from the database?`)) {
                          deleteTorrent.mutate(t.hash);
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent Plays */}
          <div className="panel">
            <div className="panel-header">
              <h3>Playback Audit History (Recent 50)</h3>
            </div>
            {health.recentPlays.length === 0 ? (
              <p className="panel-empty">No play history logged yet.</p>
            ) : (
              <div className="table-container" style={{ maxHeight: '400px', overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Show</th>
                      <th>Episode</th>
                      <th>Filename</th>
                    </tr>
                  </thead>
                  <tbody>
                    {health.recentPlays.map((p) => (
                      <tr key={p.id}>
                        <td
                          style={{
                            whiteSpace: 'nowrap',
                            fontSize: '11px',
                            color: 'var(--text-muted)',
                          }}
                        >
                          {new Date(p.at).toLocaleTimeString()}
                        </td>
                        <td>{p.titleRu}</td>
                        <td style={{ fontWeight: 'bold' }}>
                          S{String(p.season).padStart(2, '0')}E{String(p.episode).padStart(2, '0')}
                        </td>
                        <td
                          className="mono"
                          style={{
                            fontSize: '11px',
                            maxWidth: '300px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {p.rawPath}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Recent Activity -- both TorBox auto-mapping and RuTracker
            matches, merged into one chronological log. A lite, always-on
            in-app alternative to the Discord notifications (which need
            DISCORD_WEBHOOK_URL configured) -- see src/db/repositories/
            activityLogRepo.ts. */}
        <div className="panel">
          <div className="panel-header">
            <h3>Recent Activity</h3>
          </div>
          {isActivityLoading ? (
            <p className="panel-empty">Loading...</p>
          ) : activity.length === 0 ? (
            <p className="panel-empty">
              Nothing logged yet -- this fills in as torrents get auto-mapped and RuTracker
              entries get matched.
            </p>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                maxHeight: '320px',
                overflowY: 'auto',
              }}
            >
              {activity.map((entry) => (
                <div key={entry.id} className="list-item">
                  <div className="list-item-main">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className={`badge ${entry.source === 'torbox' ? 'info' : 'success'}`}>
                        {entry.source === 'torbox' ? <Box size={11} /> : <Rss size={11} />}
                        {entry.source === 'torbox' ? 'TorBox' : 'RuTracker'}
                      </span>
                      <span style={{ fontSize: '12px' }}>{entry.message}</span>
                    </div>
                    <div className="list-item-meta">{new Date(entry.at).toLocaleString()}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// --- FEED VIEW ---
interface FeedViewProps {
  feed: FeedItem[];
  isLoading: boolean;
  downloadFeedEntry: UseMutationResult<DownloadFeedEntryResponse, Error, number>;
  matchFeedEntry: UseMutationResult<
    MatchFeedEntryResponse,
    Error,
    { topicId: number; titleId: string }
  >;
  library: LibraryItem[];
}
function FeedView({ feed, isLoading, downloadFeedEntry, matchFeedEntry, library }: FeedViewProps) {
  const [downloadingTopicId, setDownloadingTopicId] = useState<number | null>(null);

  if (isLoading) return <LoadingState label="Loading RuTracker feed..." />;

  return (
    <>
      <div className="view-header">
        <h2>RuTracker Feed</h2>
      </div>

      <div className="view-body">
        {feed.length === 0 ? (
          <EmptyState
            icon={Rss}
            iconColor="var(--text-dim)"
            title="No feed matches yet"
            description="Entries matching a show in your Library will show up here after the next ingest run."
          />
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Show</th>
                  <th>Raw Title</th>
                  <th>Last Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {feed.map((item) => (
                  <tr key={item.topicId}>
                    <td style={{ minWidth: '220px' }}>
                      {item.titleName ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 'bold' }}>{item.titleName}</span>
                          {item.season !== null && item.episode !== null && (
                            <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                              S{String(item.season).padStart(2, '0')}E{String(item.episode).padStart(2, '0')}
                            </span>
                          )}
                          {item.alreadyInLibrary && (
                            <span className="badge success" title="This episode is already mapped in your Library">
                              <CheckCircle size={12} /> In Library
                            </span>
                          )}
                        </div>
                      ) : (
                        <FeedMatchPicker
                          library={library}
                          onSelect={(titleId) => matchFeedEntry.mutate({ topicId: item.topicId, titleId })}
                          disabled={matchFeedEntry.isPending}
                        />
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: '12px' }}>
                      <a href={item.url} target="_blank" rel="noreferrer">
                        {item.rawTitle} <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
                      </a>
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: '11px', color: 'var(--text-muted)' }}>
                      {new Date(item.lastUpdated).toLocaleString()}
                    </td>
                    <td>
                      {item.downloadedAt ? (
                        <span className="badge success">
                          <CheckCircle size={12} /> Downloaded
                        </span>
                      ) : (
                        <button
                          className="btn btn-primary"
                          disabled={downloadFeedEntry.isPending && downloadingTopicId === item.topicId}
                          onClick={() => {
                            setDownloadingTopicId(item.topicId);
                            downloadFeedEntry.mutate(item.topicId);
                          }}
                        >
                          <Download size={14} />
                          {downloadFeedEntry.isPending && downloadingTopicId === item.topicId
                            ? 'Downloading...'
                            : 'Download'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// --- FEED MATCH PICKER (autocomplete over already-fetched Library titles) ---
interface FeedMatchPickerProps {
  library: LibraryItem[];
  onSelect: (titleId: string) => void;
  disabled: boolean;
}
function FeedMatchPicker({ library, onSelect, disabled }: FeedMatchPickerProps) {
  const [query, setQuery] = useState('');

  const normalisedQuery = query.trim().toLowerCase();
  const matches =
    normalisedQuery.length === 0
      ? []
      : library
          .filter(
            (title) =>
              title.nameRu.toLowerCase().includes(normalisedQuery) ||
              title.nameEn?.toLowerCase().includes(normalisedQuery),
          )
          .slice(0, 8);

  return (
    <div style={{ position: 'relative' }}>
      <input
        type="text"
        placeholder="(unmatched) -- search your Library..."
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        style={{ fontSize: '12px', padding: '4px 8px', width: '100%' }}
      />
      {matches.length > 0 && (
        <div className="dropdown-panel" style={{ maxHeight: '180px' }}>
          {matches.map((title) => (
            <div
              key={title.id}
              className="dropdown-panel-item"
              style={{ fontSize: '12px' }}
              onClick={() => {
                onSelect(title.id);
                setQuery('');
              }}
            >
              {title.nameRu}
              {title.nameEn ? ` / ${title.nameEn}` : ''}
              {title.year ? ` (${title.year})` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AdminApp />
    </QueryClientProvider>
  );
}
