export type EpisodeStage =
  | 'seasonEpisode'
  | 'episodeNumber'
  | 'airDate'
  | 'leadingNumber'
  | 'positional';

export interface XofYResult {
  present: number;
  total: number;
  raw: string;
}

export interface AirDateResult {
  date: string; // YYYY-MM-DD
  raw: string;
}

export interface TorrentParseResult {
  season: number | null;
  xOfY: XofYResult | null;
  airDate: AirDateResult | null;
  cleanedTitle: string;
}

export interface FileParseResult {
  season: number | null;
  episode: number | null;
  absoluteHint: number | null;
  airDate: AirDateResult | null;
  stage: EpisodeStage | null;
}

export interface MaskResult {
  masked: string;
  airDate: AirDateResult | null;
  seasonEpisode: { season: number; episode: number; raw: string } | null;
}
