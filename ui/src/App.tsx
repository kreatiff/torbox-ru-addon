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

interface QueueItem {
  hash: string;
  rawNameAtIngest: string;
  firstSeen: string;
  fileCount: number;
  proposal: {
    proposedTitle: string;
    proposedSeason: number;
    confidence: number;
    why: string;
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
  seasons: LibrarySeason[];
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
    throw new Error(`API error: ${res.statusText} (${res.status})`);
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

function AdminApp() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'queue' | 'labeller' | 'library' | 'health'>('queue');

  // Navigation index for queue
  const [selectedQueueIdx, setSelectedQueueIdx] = useState<number>(0);

  // Selected torrent for Labeller
  const [selectedTorrentHash, setSelectedTorrentHash] = useState<string | null>(null);

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

  const { data: torrentDetails, isLoading: isDetailsLoading } = useQuery({
    queryKey: ['torrentDetails', selectedTorrentHash],
    queryFn: () => apiFetch<TorrentDetails>(`/api/torrents/${selectedTorrentHash}`),
    enabled: !!selectedTorrentHash,
  });

  // Mutations
  const triggerIngest = useMutation({
    mutationFn: () => apiFetch<IngestRunResult>('/api/ingest/run', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] });
      alert('Ingest run successfully triggered in the background.');
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
      setSelectedTorrentHash(null);
      setActiveTab('queue');
    },
    onError: (err) => {
      alert(`Failed to save rule: ${err.message}`);
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
            const accept = window.confirm(
              `Quick-accept proposal: "${target.proposal.proposedTitle}" (Season ${target.proposal.proposedSeason})?`,
            );
            if (accept) {
              saveRule.mutate({
                torrentHash: target.hash,
                season: target.proposal.proposedSeason,
                numbering: 'sequential',
                sort: 'natural',
                startEpisode: 1,
                exceptions: {},
                title: {
                  nameRu: target.proposal.proposedTitle,
                },
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
          <h1>TorBox RU Addon</h1>
          <span>Self-hosted Russian TV Mapper</span>
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
                alert('Please select a torrent from the Queue first.');
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
              setActiveTab('labeller');
            }}
          />
        )}

        {activeTab === 'labeller' && (
          <LabellerView
            key={selectedTorrentHash}
            hash={selectedTorrentHash}
            details={torrentDetails}
            isLoading={isDetailsLoading}
            saveRule={saveRule}
            onCancel={() => {
              setSelectedTorrentHash(null);
              setActiveTab('queue');
            }}
          />
        )}

        {activeTab === 'library' && <LibraryView library={library} isLoading={isLibraryLoading} />}

        {activeTab === 'health' && (
          <HealthView health={health} isLoading={isHealthLoading} triggerIngest={triggerIngest} />
        )}
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
}
function QueueView({ queue, isLoading, selectedIdx, setSelectedIdx, onSelect }: QueueViewProps) {
  if (isLoading) return <div className="view-body">Loading queue...</div>;
  if (queue.length === 0) {
    return (
      <div className="view-body" style={{ textAlign: 'center', paddingTop: '100px' }}>
        <CheckCircle size={48} color="var(--accent-success)" style={{ marginBottom: '16px' }} />
        <h3>All caught up!</h3>
        <p style={{ color: 'var(--text-muted)' }}>There are no active torrents awaiting review.</p>
      </div>
    );
  }

  return (
    <>
      <div className="view-header">
        <h2>Ingested Review Queue</h2>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Use <kbd>j</kbd>/<kbd>k</kbd> to navigate, <kbd>Enter</kbd> to open, <kbd>a</kbd> to
          quick-approve
        </span>
      </div>
      <div className="view-body">
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Torrent Name</th>
                <th style={{ width: '80px', textAlign: 'center' }}>Files</th>
                <th>Proposed Show Mapping</th>
                <th style={{ width: '80px', textAlign: 'center' }}>Season</th>
                <th style={{ width: '80px', textAlign: 'center' }}>Conf.</th>
                <th style={{ width: '60px' }}></th>
              </tr>
            </thead>
            <tbody>
              {queue.map((item, idx) => (
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
                  <td style={{ textAlign: 'center' }}>{item.fileCount}</td>
                  <td>{item.proposal?.proposedTitle || '-'}</td>
                  <td style={{ textAlign: 'center' }}>{item.proposal?.proposedSeason ?? '-'}</td>
                  <td style={{ textAlign: 'center' }}>
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
  onCancel: () => void;
}
function LabellerView({ hash, details, isLoading, saveRule, onCancel }: LabellerViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<TmdbSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedShow, setSelectedShow] = useState<TmdbSearchResult | null>(null);
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

  if (isLoading || !details) return <div className="view-body">Loading files details...</div>;

  // Auto-fill proposed season/search query from the torrent name, once, the
  // first time `details` becomes available (adjusting state during render
  // instead of in an effect -- see https://react.dev/learn/you-might-not-need-an-effect).
  if (!initialized) {
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
      torrentHash: hash,
      season,
      numbering: numberingMode,
      sort: sortMode,
      startEpisode,
      absoluteOffset,
      exceptions,
      title: {
        tmdbId: selectedShow.tmdbId,
        nameRu: selectedShow.nameRu,
        nameEn: selectedShow.nameEn,
        year: selectedShow.year,
        posterUrl: selectedShow.posterUrl,
      },
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
        <h2>Manual Mapping Labeller</h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={saveRule.isPending}>
            {saveRule.isPending ? 'Saving...' : 'Save Rule & Mappings'}
          </button>
        </div>
      </div>

      <div className="view-body">
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
              {selectedShow && <span className="badge info">TMDB: {selectedShow.tmdbId}</span>}
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
                  <div
                    style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      right: 0,
                      backgroundColor: 'var(--bg-surface-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: '6px',
                      maxHeight: '200px',
                      overflowY: 'auto',
                      zIndex: 10,
                      marginTop: '4px',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                    }}
                  >
                    {searchResults.map((show) => (
                      <div
                        key={show.tmdbId}
                        style={{
                          display: 'flex',
                          gap: '12px',
                          padding: '8px 12px',
                          borderBottom: '1px solid var(--border)',
                          cursor: 'pointer',
                        }}
                        onClick={() => {
                          setSelectedShow(show);
                          setSearchResults([]);
                        }}
                        className="hover-highlight"
                      >
                        {show.posterUrl ? (
                          <img
                            src={show.posterUrl}
                            alt=""
                            style={{
                              width: '30px',
                              height: '45px',
                              objectFit: 'cover',
                              borderRadius: '2px',
                            }}
                          />
                        ) : (
                          <div
                            style={{
                              width: '30px',
                              height: '45px',
                              backgroundColor: 'var(--bg-main)',
                              borderRadius: '2px',
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
                <div
                  style={{
                    display: 'flex',
                    gap: '12px',
                    padding: '12px',
                    backgroundColor: 'var(--bg-surface-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                  }}
                >
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
                    <option value="parsed" disabled>
                      parsed (Unimplemented)
                    </option>
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

// --- LIBRARY VIEW ---
interface LibraryViewProps {
  library: LibraryItem[];
  isLoading: boolean;
}
function LibraryView({ library, isLoading }: LibraryViewProps) {
  if (isLoading) return <div className="view-body">Loading library grid...</div>;

  return (
    <>
      <div className="view-header">
        <h2>Seeded & Mapped Library</h2>
      </div>
      <div className="view-body">
        <div className="library-grid">
          {library.map((show) => (
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
                <div className="library-card-title-info">
                  <h3>{show.nameRu}</h3>
                  <span style={{ display: 'block' }}>{show.nameEn}</span>
                  <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                    {show.year ?? 'N/A'} •{' '}
                    {show.imdbId || show.tmdbId
                      ? show.imdbId || `tmdb:${show.tmdbId}`
                      : 'No Provider ID'}
                  </span>
                </div>
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
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// --- HEALTH VIEW ---
interface HealthViewProps {
  health: HealthData | undefined;
  isLoading: boolean;
  triggerIngest: UseMutationResult<IngestRunResult, Error, void>;
}
function HealthView({ health, isLoading, triggerIngest }: HealthViewProps) {
  if (isLoading || !health) return <div className="view-body">Loading health statistics...</div>;

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
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              padding: '16px',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              display: 'flex',
              gap: '16px',
            }}
          >
            <Clock size={32} color="var(--accent-info)" />
            <div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>
                Last Ingest Run
              </span>
              <strong style={{ fontSize: '16px' }}>
                {health.lastIngestRun
                  ? new Date(health.lastIngestRun).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : 'Never'}
              </strong>
            </div>
          </div>

          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              padding: '16px',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              display: 'flex',
              gap: '16px',
            }}
          >
            <AlertTriangle size={32} color="var(--accent-danger)" />
            <div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>
                Gone Torrents
              </span>
              <strong style={{ fontSize: '16px' }}>{health.goneCount}</strong>
            </div>
          </div>

          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              padding: '16px',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              display: 'flex',
              gap: '16px',
            }}
          >
            <Database size={32} color="var(--accent-attention)" />
            <div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>
                Dangling Mappings
              </span>
              <strong style={{ fontSize: '16px' }}>{health.danglingMappings}</strong>
            </div>
          </div>

          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              padding: '16px',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              display: 'flex',
              gap: '16px',
            }}
          >
            <FileText size={32} color="var(--text-muted)" />
            <div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>
                Files w/o Mount Path
              </span>
              <strong style={{ fontSize: '16px' }}>{health.filesNoMountPath}</strong>
            </div>
          </div>
        </div>

        {/* Gone list & Play log split */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px' }}>
          {/* Gone List */}
          <div
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              padding: '16px',
            }}
          >
            <h3 style={{ margin: '0 0 16px 0', fontSize: '14px', fontWeight: 600 }}>
              Gone Torrents Audit (Recent 10)
            </h3>
            {health.goneTorrents.length === 0 ? (
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                No gone torrents recorded.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {health.goneTorrents.map((t) => (
                  <div
                    key={t.hash}
                    style={{
                      padding: '8px',
                      background: 'var(--bg-main)',
                      border: '1px solid var(--border)',
                      borderRadius: '6px',
                      fontSize: '12px',
                    }}
                  >
                    <div
                      className="mono"
                      style={{
                        fontWeight: 600,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t.name}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                      Last seen: {new Date(t.lastSeen).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent Plays */}
          <div
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              padding: '16px',
            }}
          >
            <h3 style={{ margin: '0 0 16px 0', fontSize: '14px', fontWeight: 600 }}>
              Playback Audit History (Recent 50)
            </h3>
            {health.recentPlays.length === 0 ? (
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                No play history logged yet.
              </p>
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
      </div>
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AdminApp />
    </QueryClientProvider>
  );
}
