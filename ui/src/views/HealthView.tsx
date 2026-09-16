import type { UseMutationResult } from '@tanstack/react-query';
import { AlertTriangle, Clock, Database, FileText, Rss, Trash2, Box } from 'lucide-react';
import type {
  IngestRunResult,
  HealthData,
  NonRussianAuditResult,
  ActivityEntry,
} from '../types.js';
import { LoadingState } from '../components/states.js';

// --- HEALTH VIEW ---
interface HealthViewProps {
  health: HealthData | undefined;
  isLoading: boolean;
  triggerIngest: UseMutationResult<IngestRunResult, Error, void>;
  deleteTorrent: UseMutationResult<{ success: boolean }, Error, string>;
  purgeGoneTorrents: UseMutationResult<{ success: boolean; deletedCount: number }, Error, void>;
  activity: ActivityEntry[];
  isActivityLoading: boolean;
  nonRussianAudit: NonRussianAuditResult | undefined;
  isNonRussianAuditFetching: boolean;
  nonRussianAuditError: Error | null;
  scanNonRussianTitles: () => void;
  deleteNonRussianTitle: UseMutationResult<{ success: boolean }, Error, string>;
}
export function HealthView({
  health,
  isLoading,
  triggerIngest,
  deleteTorrent,
  purgeGoneTorrents,
  activity,
  isActivityLoading,
  nonRussianAudit,
  isNonRussianAuditFetching,
  nonRussianAuditError,
  scanNonRussianTitles,
  deleteNonRussianTitle,
}: HealthViewProps) {
  if (isLoading || !health) return <LoadingState label="Loading health statistics..." />;

  return (
    <>
      <div className="view-header">
        <h2>System Health Dashboard</h2>
        <div className="view-header-actions">
          <button
            className="btn btn-primary"
            onClick={() => triggerIngest.mutate()}
            disabled={triggerIngest.isPending}
          >
            {triggerIngest.isPending ? 'Ingesting...' : 'Trigger Ingest Run Now'}
          </button>
        </div>
      </div>

      <div className="view-body" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {/* Row of stats cards */}
        <div
          className="stat-grid"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}
        >
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
        <div
          className="health-columns"
          style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px' }}
        >
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
                {purgeGoneTorrents.isPending
                  ? 'Deleting...'
                  : `Delete All Gone (${health.goneCount})`}
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
                          data-label="Time"
                          style={{
                            whiteSpace: 'nowrap',
                            fontSize: '11px',
                            color: 'var(--text-muted)',
                          }}
                        >
                          {new Date(p.at).toLocaleTimeString()}
                        </td>
                        <td data-label="Show">{p.titleRu}</td>
                        <td data-label="Episode" style={{ fontWeight: 'bold' }}>
                          S{String(p.season).padStart(2, '0')}E{String(p.episode).padStart(2, '0')}
                        </td>
                        <td
                          className="mono"
                          data-label="Filename"
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
              Nothing logged yet -- this fills in as torrents get auto-mapped and RuTracker entries
              get matched.
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

        {/* Non-Russian Titles audit (docs/decisions.md's "Russian-only
            auto-match gate") -- manually triggered, not polled like /health,
            since it does one live TMDB call per title with a tmdb_id and can
            take a while. Same scan/delete src/library/nonRussianAudit.ts
            backs scripts/audit-non-russian-titles.ts too. */}
        <div className="panel">
          <div className="panel-header">
            <h3>Non-Russian Titles Audit</h3>
            <button
              className="btn btn-secondary"
              style={{ padding: '4px 10px', fontSize: '11px' }}
              disabled={isNonRussianAuditFetching}
              onClick={() => scanNonRussianTitles()}
            >
              {isNonRussianAuditFetching ? 'Scanning...' : 'Scan Library'}
            </button>
          </div>
          {nonRussianAuditError ? (
            <p className="panel-empty">Scan failed: {nonRussianAuditError.message}</p>
          ) : !nonRussianAudit ? (
            <p className="panel-empty">
              Re-checks every title's live TMDB language and flags anything that isn't Russian --
              catches titles the auto-match pipeline added before it started gating on this. Can
              take a minute on a large library.
            </p>
          ) : nonRussianAudit.flagged.length === 0 ? (
            <p className="panel-empty">
              Checked {nonRussianAudit.checked} of {nonRussianAudit.total} title(s) -- none flagged.
            </p>
          ) : (
            <>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 8px' }}>
                Checked {nonRussianAudit.checked} of {nonRussianAudit.total} title(s) --{' '}
                {nonRussianAudit.flagged.length} flagged.
              </p>
              <div className="table-container" style={{ maxHeight: '320px', overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Lang</th>
                      <th>Rules</th>
                      <th>Mappings</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {nonRussianAudit.flagged.map((t) => (
                      <tr key={t.id}>
                        <td data-label="Title">
                          {t.nameRu}
                          {t.nameEn ? (
                            <span style={{ color: 'var(--text-muted)' }}> ({t.nameEn})</span>
                          ) : null}
                        </td>
                        <td className="mono" data-label="Lang">
                          {t.originalLanguage ?? 'unknown'}
                        </td>
                        <td data-label="Rules">{t.ruleCount}</td>
                        <td data-label="Mappings">{t.mappingCount}</td>
                        <td>
                          <button
                            className="icon-btn"
                            title="Delete this title (and its rules/mappings) from the database"
                            disabled={deleteNonRussianTitle.isPending}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Delete "${t.nameRu}" and its ${t.ruleCount} rule(s)/${t.mappingCount} mapping(s)? This cannot be undone.`,
                                )
                              ) {
                                deleteNonRussianTitle.mutate(t.id);
                              }
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
