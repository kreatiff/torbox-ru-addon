import { useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import { CheckCircle, RefreshCw, Rss, Download, ExternalLink } from 'lucide-react';
import type {
  LibraryItem,
  FeedItem,
  DownloadFeedEntryResponse,
  MatchFeedEntryResponse,
  RefreshFeedResponse,
} from '../types.js';
import { LoadingState, EmptyState } from '../components/states.js';

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
  refreshFeed: UseMutationResult<RefreshFeedResponse, Error, void>;
  library: LibraryItem[];
}
export function FeedView({
  feed,
  isLoading,
  downloadFeedEntry,
  matchFeedEntry,
  refreshFeed,
  library,
}: FeedViewProps) {
  const [downloadingTopicId, setDownloadingTopicId] = useState<number | null>(null);

  if (isLoading) return <LoadingState label="Loading RuTracker feed..." />;

  return (
    <>
      <div className="view-header">
        <h2>RuTracker Feed</h2>
        <div className="view-header-actions">
          <button
            className="btn btn-primary"
            onClick={() => refreshFeed.mutate()}
            disabled={refreshFeed.isPending}
          >
            {refreshFeed.isPending ? (
              <>
                <RefreshCw className="animate-spin" size={14} /> Refreshing...
              </>
            ) : (
              <>
                <RefreshCw size={14} /> Refresh Feed
              </>
            )}
          </button>
        </div>
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
                    <td data-label="Show" style={{ minWidth: '220px' }}>
                      {item.titleName ? (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            flexWrap: 'wrap',
                          }}
                        >
                          <span style={{ fontWeight: 'bold' }}>{item.titleName}</span>
                          {item.season !== null && item.episode !== null && (
                            <span
                              className="mono"
                              style={{ fontSize: '11px', color: 'var(--text-muted)' }}
                            >
                              S{String(item.season).padStart(2, '0')}E
                              {String(item.episode).padStart(2, '0')}
                            </span>
                          )}
                          {item.alreadyInLibrary && (
                            <span
                              className="badge success"
                              title="This episode is already mapped in your Library"
                            >
                              <CheckCircle size={12} /> In Library
                            </span>
                          )}
                        </div>
                      ) : (
                        <FeedMatchPicker
                          library={library}
                          onSelect={(titleId) =>
                            matchFeedEntry.mutate({ topicId: item.topicId, titleId })
                          }
                          disabled={matchFeedEntry.isPending}
                        />
                      )}
                    </td>
                    <td className="mono" data-label="Raw Title" style={{ fontSize: '12px' }}>
                      <a href={item.url} target="_blank" rel="noreferrer">
                        {item.rawTitle}{' '}
                        <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
                      </a>
                    </td>
                    <td
                      data-label="Last Updated"
                      style={{ whiteSpace: 'nowrap', fontSize: '11px', color: 'var(--text-muted)' }}
                    >
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
                          disabled={
                            downloadFeedEntry.isPending && downloadingTopicId === item.topicId
                          }
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
export function FeedMatchPicker({ library, onSelect, disabled }: FeedMatchPickerProps) {
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
