import { useState } from 'react';
import { FolderOpen, Search, Pencil } from 'lucide-react';
import type { LibraryItem, TitleRecord } from '../types.js';
import { LoadingState, EmptyState } from '../components/states.js';

// --- LIBRARY VIEW ---
interface LibraryViewProps {
  library: LibraryItem[];
  isLoading: boolean;
  onEditRule: (torrentHash: string, ruleId: string) => void;
  onAddTitle: () => void;
  onEditTitle: (title: TitleRecord) => void;
}
export function LibraryView({
  library,
  isLoading,
  onEditRule,
  onAddTitle,
  onEditTitle,
}: LibraryViewProps) {
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
        <div className="view-header-actions" style={{ gap: '8px' }}>
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
                    <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                      {show.year ?? 'N/A'}
                    </span>
                    <div
                      style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}
                    >
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
                                  style={{
                                    marginLeft: 'auto',
                                    padding: '2px 8px',
                                    fontSize: '11px',
                                  }}
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
