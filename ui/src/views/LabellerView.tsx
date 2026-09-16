import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { CheckCircle, AlertTriangle, Search, RefreshCw } from 'lucide-react';
import { apiFetch } from '../api.js';
import { expandRule } from '../../../src/resolve/expandRule.ts';
import type { RuleFile, Mapping, Rule, RuleException } from '../../../src/resolve/types.ts';
import type {
  TmdbSearchResult,
  SelectedShowInfo,
  TorrentDetails,
  SaveRuleBody,
  SaveRuleResponse,
  PreviewResponse,
} from '../types.js';
import { highlightHomoglyphs, parseXizY, formatBytes } from '../lib/format.js';
import { LoadingState } from '../components/states.js';

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
export function LabellerView({
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
    queueReason: null,
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
        <div className="view-header-actions" style={{ gap: '8px' }}>
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => previewWithAi.mutate()}
            disabled={previewWithAi.isPending || !hash}
            title="Runs the LLM extraction for this torrent and fills in the fields below for review -- nothing is saved until you click Save."
          >
            {previewWithAi.isPending
              ? 'Asking the LLM… (can take up to a minute)'
              : 'Preview with AI'}
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
            {lastPreview.tier === 'commit' ? (
              <CheckCircle size={16} />
            ) : (
              <AlertTriangle size={16} />
            )}
            <span>
              <strong>
                AI preview ({lastPreview.tier === 'commit' ? 'confident' : 'needs review'}):
              </strong>{' '}
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
              <div
                className="labeller-controls-grid"
                style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}
              >
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
