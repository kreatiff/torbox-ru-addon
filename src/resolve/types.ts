// Spec-verbatim shape (§3.7), extended with `id` (needed to stamp Mapping.ruleId
// -- expandRule can't produce that field without it) and the bookkeeping columns
// the DB row actually carries (confidence/source). Numbering-mode semantics for
// each of the four values are documented in numbering.ts, not here -- the spec
// gives the type shape but not the per-mode algorithm (plan.md §3.1).
export interface Rule {
  id: string;
  torrentHash: string;
  titleId: string | null;
  season: number;
  numbering: 'sequential' | 'parsed' | 'continuous' | 'manual';
  sort: 'natural' | 'path';
  startEpisode: number;
  absoluteOffset: number | null;
  exceptions: Record<string, RuleException>;
  confidence: number;
  source: 'auto' | 'manual';
  proposalReason: string | null;
  torrentName: string | null;
}

export type RuleException = { season: number; episode: number } | 'ignore';

// The minimal per-file shape expandRule actually needs -- deliberately not the
// full DB File type, so this pure module stays decoupled from torbox_file_id/
// mount_path/torrent_hash, none of which the numbering logic touches.
export interface RuleFile {
  id: number;
  path: string;
  isVideo: boolean;
}

export interface Mapping {
  fileId: number;
  titleId: string | null;
  season: number;
  episode: number;
  ruleId: string;
}

export type RuleProposal = Omit<Rule, 'id'>;
