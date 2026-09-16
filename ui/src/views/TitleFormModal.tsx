import { useState } from 'react';
import { Search, RefreshCw, X } from 'lucide-react';
import { apiFetch } from '../api.js';
import type { TmdbSearchResult, ResolvedTitleIds, TitleFormBody, TitleRecord } from '../types.js';

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
export function TitleFormModal({
  mode,
  initial,
  isSubmitting,
  onClose,
  onSubmit,
}: TitleFormModalProps) {
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
              <input type="number" value={year} onChange={(e) => setYear(e.target.value)} />
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
