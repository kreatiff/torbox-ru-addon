import { useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import { CheckCircle, Search } from 'lucide-react';
import type { QueueItem, IngestRunResult } from '../types.js';
import { highlightHomoglyphs } from '../lib/format.js';
import { LoadingState, EmptyState } from '../components/states.js';

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
export function QueueView({
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
        <span className="kbd-hint" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
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
                      data-label="Torrent Name"
                      style={{
                        maxWidth: '400px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {highlightHomoglyphs(item.rawNameAtIngest)}
                    </td>
                    <td className="col-center" data-label="Files">
                      {item.fileCount}
                    </td>
                    <td data-label="Proposed Show Mapping">
                      {item.proposal?.proposedTitle || '-'}
                    </td>
                    <td className="col-center" data-label="Season">
                      {item.proposal?.proposedSeason ?? '-'}
                    </td>
                    <td className="col-center" data-label="Confidence">
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
