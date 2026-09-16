import { useState, useEffect } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  List,
  Tag,
  FolderOpen,
  Activity,
  CheckCircle,
  AlertTriangle,
  Rss,
  X,
  Box,
  LogOut,
} from 'lucide-react';
import { AuthProvider, LoginPage } from './auth.js';
import { useAuth } from './useAuth.js';
import { apiFetch } from './api.js';
import { useTapTooltips } from './useTapTooltips.js';
import type {
  QueueItem,
  LibraryItem,
  TorrentDetails,
  HealthData,
  ActivityEntry,
  FeedItem,
  SaveRuleBody,
  SaveRuleResponse,
  IngestRunResult,
  TitleFormBody,
  TitleRecord,
  TitleMutationResponse,
  NonRussianAuditResult,
  DownloadFeedEntryResponse,
  MatchFeedEntryResponse,
  RefreshFeedResponse,
} from './types.js';
import { QueueView } from './views/QueueView.js';
import { LabellerView } from './views/LabellerView.js';
import { LibraryView } from './views/LibraryView.js';
import { HealthView } from './views/HealthView.js';
import { FeedView } from './views/FeedView.js';
import { TitleFormModal } from './views/TitleFormModal.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

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
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<TabId>(getInitialTab);
  useTapTooltips();

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
  // Mobile-only: the sidebar footer's account info, surfaced via the top
  // bar's avatar button instead (the sidebar is hidden below 769px).
  const [accountSheetOpen, setAccountSheetOpen] = useState(false);
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

  const refreshFeed = useMutation({
    mutationFn: () => apiFetch<RefreshFeedResponse>('/api/feed/refresh', { method: 'POST' }),
    onSuccess: (result) => {
      if (!result.success) {
        showToast(`Feed refresh failed: ${result.error ?? 'unknown error'}`, 'error');
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['feed'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      const { feedEntriesNew = 0, feedEntriesMatched = 0 } = result;
      showToast(
        feedEntriesNew > 0
          ? `Feed refreshed: ${feedEntriesNew} new of ${feedEntriesMatched} matched.`
          : `Feed refreshed: no new entries (${feedEntriesMatched} matched).`,
      );
    },
    onError: (err) => {
      showToast(`Feed refresh failed: ${err.message}`, 'error');
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
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: ['torrentDetails'] });
      setSelectedTorrentHash(null);
      setEditingRuleId(null);
      setActiveTab(returnTab);
      // The server responds 207 (still `res.ok`, so apiFetch treats it as
      // success) when the rule itself saved but rebuilding its mappings
      // failed -- e.g. two rules on one torrent whose file ranges overlap
      // (see docs/decisions.md). Without this, that failure was invisible:
      // the rule looked saved and the human had no idea its season ended
      // up with zero mappings.
      if (result.warning) {
        showToast(result.warning, 'error');
      }
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
    mutationFn: (hash: string) =>
      apiFetch<{ success: boolean }>(`/api/torrents/${hash}`, { method: 'DELETE' }),
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
      showToast(
        `Deleted ${result.deletedCount} gone torrent${result.deletedCount === 1 ? '' : 's'}.`,
      );
    },
    onError: (err) => {
      showToast(`Purge failed: ${err.message}`, 'error');
    },
  });

  // Non-Russian Titles audit (Health tab) -- a manually-triggered scan, not
  // polled automatically like /health: it does one live TMDB call per
  // title with a tmdb_id, so it can take a while on a large library.
  // `enabled: false` + `refetch()` (rather than a useMutation wrapping the
  // same GET) is what lets a successful delete below patch this query's
  // cached result in place instead of losing the scan on every row delete.
  const {
    data: nonRussianAudit,
    isFetching: isNonRussianAuditFetching,
    refetch: scanNonRussianTitles,
    error: nonRussianAuditError,
  } = useQuery({
    queryKey: ['nonRussianAudit'],
    queryFn: () => apiFetch<NonRussianAuditResult>('/api/titles/non-russian-audit'),
    enabled: false,
    retry: false,
  });

  const deleteNonRussianTitle = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ success: boolean }>(`/api/titles/${id}`, { method: 'DELETE' }),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<NonRussianAuditResult | undefined>(['nonRussianAudit'], (prev) =>
        prev ? { ...prev, flagged: prev.flagged.filter((f) => f.id !== id) } : prev,
      );
      queryClient.invalidateQueries({ queryKey: ['library'] });
      showToast('Title deleted.');
    },
    onError: (err) => {
      showToast(`Delete failed: ${err.message}`, 'error');
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
          {user && (
            <>
              <span
                style={{
                  fontSize: '11px',
                  color: 'var(--text-dim)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: '100%',
                }}
                title={user.email}
              >
                {user.email}
              </span>
              <button
                className="btn btn-secondary"
                style={{ padding: '4px 8px', fontSize: '11px', width: '100%' }}
                onClick={() => logout()}
              >
                <LogOut size={12} style={{ marginRight: '6px' }} />
                Sign out
              </button>
            </>
          )}
        </div>
      </div>

      {/* Mobile top bar -- replaces the sidebar header below 769px; see
          index.css's "Mobile / responsive" section. */}
      <div className="mobile-topbar">
        <div className="mobile-topbar-brand">
          <div className="sidebar-brand-mark">
            <Box size={16} />
          </div>
          <h1>TorBox RU Addon</h1>
        </div>
        <button
          className="mobile-avatar-btn"
          onClick={() => setAccountSheetOpen(true)}
          aria-label="Account"
        >
          {user?.email ? user.email.charAt(0).toUpperCase() : <LogOut size={16} />}
        </button>
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
            nonRussianAudit={nonRussianAudit}
            isNonRussianAuditFetching={isNonRussianAuditFetching}
            nonRussianAuditError={nonRussianAuditError}
            scanNonRussianTitles={scanNonRussianTitles}
            deleteNonRussianTitle={deleteNonRussianTitle}
          />
        )}

        {activeTab === 'feed' && (
          <FeedView
            feed={feed}
            isLoading={isFeedLoading}
            downloadFeedEntry={downloadFeedEntry}
            matchFeedEntry={matchFeedEntry}
            refreshFeed={refreshFeed}
            library={library}
          />
        )}
      </div>

      {/* Bottom tab bar -- mobile-only equivalent of the sidebar menu. */}
      <nav className="bottom-nav">
        <div className="bottom-nav-inner">
          <button
            className={`bottom-nav-item ${activeTab === 'queue' ? 'active' : ''}`}
            onClick={() => setActiveTab('queue')}
          >
            <List size={19} />
            Queue
            {queue.length > 0 && <span className="bottom-nav-item-badge">{queue.length}</span>}
          </button>
          <button
            className={`bottom-nav-item ${activeTab === 'labeller' ? 'active' : ''}`}
            onClick={() => {
              if (selectedTorrentHash) {
                setActiveTab('labeller');
              } else {
                showToast('Please select a torrent from the Queue first.', 'error');
              }
            }}
          >
            <Tag size={19} />
            Labeller
          </button>
          <button
            className={`bottom-nav-item ${activeTab === 'library' ? 'active' : ''}`}
            onClick={() => setActiveTab('library')}
          >
            <FolderOpen size={19} />
            Library
          </button>
          <button
            className={`bottom-nav-item ${activeTab === 'health' ? 'active' : ''}`}
            onClick={() => setActiveTab('health')}
          >
            <Activity size={19} />
            Health
          </button>
          <button
            className={`bottom-nav-item ${activeTab === 'feed' ? 'active' : ''}`}
            onClick={() => setActiveTab('feed')}
          >
            <Rss size={19} />
            Feed
            {feed.filter((f) => !f.downloadedAt).length > 0 && (
              <span className="bottom-nav-item-badge">
                {feed.filter((f) => !f.downloadedAt).length}
              </span>
            )}
          </button>
        </div>
      </nav>

      {/* Account sheet (mobile) -- the sidebar footer's user/sign-out info,
          reachable via the top bar's avatar button since the sidebar itself
          is hidden below 769px. Reuses the modal/bottom-sheet styling. */}
      {accountSheetOpen && (
        <div className="modal-overlay" onClick={() => setAccountSheetOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Account</h3>
              <button className="icon-btn" onClick={() => setAccountSheetOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              {user?.email && (
                <div className="form-group">
                  <label>Signed in as</label>
                  <div style={{ fontSize: '14px', wordBreak: 'break-all' }}>{user.email}</div>
                </div>
              )}
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Status</label>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {health?.lastIngestRun
                    ? `Last ingested ${new Date(health.lastIngestRun).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}`
                    : 'Never ingested'}{' '}
                  • v0.1.0
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                style={{ width: '100%' }}
                onClick={() => {
                  setAccountSheetOpen(false);
                  logout();
                }}
              >
                <LogOut size={14} style={{ marginRight: '6px' }} />
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}

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

function AppContent() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--bg-main)',
          color: 'var(--text-muted)',
        }}
      >
        Loading...
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return <AdminApp />;
}

export default function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <AppContent />
      </QueryClientProvider>
    </AuthProvider>
  );
}
