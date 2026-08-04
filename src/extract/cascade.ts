import { normalise } from '../normalize/normalise.js';
import { naturalCompare } from './naturalSort.js';
import type { EpisodeStage, FileParseResult, TorrentParseResult } from './types.js';
import { maskTokens } from './maskTokens.js';
import { parseAirDate } from './airDate.js';
import { parseXofY } from './xOfY.js';

import { parseEpisodeNumber } from './episodeNumber.js';
import { originalEpisodeWordsList } from './vocabulary.js';
import type { MaskConfig } from './qualityCodecTokens.js';

// Season marker is extracted from the original torrent name because the
// Cyrillic word "сезон" folds to mixed-script "ceзoн" under normalisation,
// making the original string a more reliable extraction target.
const seasonRegex = /(\d{1,2})\s*(?:сезон|season)/i;

/**
 * Extract season, X из Y, air date, and a cleaned title from the torrent name.
 */
export function parseTorrent(torrentName: string): TorrentParseResult {
  const normalised = normalise(torrentName);
  const masked = maskTokens(normalised);

  const seasonMatch = torrentName.match(seasonRegex);
  const season =
    (seasonMatch && seasonMatch[1] ? parseInt(seasonMatch[1], 10) : null) ??
    masked.seasonEpisode?.season ??
    null;

  const xOfY = parseXofY(normalised);
  const airDate = parseAirDate(normalised);

  // Clean the title on the original string (Cyrillic metadata markers are
  // easier to remove before normalisation), then mask remaining tokens and
  // normalise. This yields a title suitable for exact/near-exact matching.
  const episodeWordsPattern = originalEpisodeWordsList
    .map((w) => w.replace(/\./g, '\\.'))
    .join('|');
  let cleanedTitle = torrentName
    .replace(/\[.*?\]/g, ' ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\d{1,2}\s*(?:сезон|season)/gi, ' ')
    .replace(
      new RegExp(
        `\\d{1,3}\\s*(?:-\\s*\\d{1,3})?\\s*(?:из|iz|u3)\\s*\\d{1,3}(?:\\s*(?:${episodeWordsPattern}))?`,
        'gi',
      ),
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();

  cleanedTitle = normalise(cleanedTitle);
  const cleanedMasked = maskTokens(cleanedTitle);
  cleanedTitle = cleanedMasked.masked
    .replace(/__QUALITY__/g, ' ')
    .replace(/__RELEASE__/g, ' ')
    .replace(/__YEAR__/g, ' ')
    .replace(/__AIR_DATE__/g, ' ')
    .replace(/__SEASON_EPISODE__/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { season, xOfY, airDate, cleanedTitle };
}

/**
 * Extract episode information from one source string (either a file path or a
 * torrent name for single-file torrents). Returns the highest-confidence
 * stage match.
 *
 * The input is expected to already be normalised.
 */
export function parseEpisodeSource(
  source: string,
  torrentParse: TorrentParseResult,
  config?: MaskConfig,
): FileParseResult {
  const masked = maskTokens(source, config);
  let absoluteHint: number | null = null;

  // Capture the leading bare number as a cross-check signal regardless of
  // which higher stage wins — the spec's Bolshoy Kush invariant.
  const leadingNumber = masked.masked.match(/^\s*(\d{1,3})\b/);
  if (leadingNumber && leadingNumber[1]) {
    absoluteHint = parseInt(leadingNumber[1], 10);
  }

  // Stage 1: explicit SxxExx.
  if (masked.seasonEpisode) {
    return {
      season: masked.seasonEpisode.season,
      episode: masked.seasonEpisode.episode,
      absoluteHint,
      airDate: null,
      stage: 'seasonEpisode',
    };
  }

  // Stage 2: number + episode word / episode word + number.
  const episodeNumber = parseEpisodeNumber(masked.masked);
  if (episodeNumber) {
    return { ...episodeNumber, absoluteHint };
  }

  // Stage 3: air date present in the source.
  if (masked.airDate) {
    return {
      season: null,
      episode: null,
      absoluteHint,
      airDate: masked.airDate,
      stage: 'airDate',
    };
  }

  // Stage 4: leading bare number — signal already captured.
  if (absoluteHint !== null) {
    return {
      season: null,
      episode: null,
      absoluteHint,
      airDate: null,
      stage: 'leadingNumber',
    };
  }

  // Stage 5: positional fallback — caller fills episode after natural sort.
  return {
    season: null,
    episode: null,
    absoluteHint: null,
    airDate: null,
    stage: 'positional',
  };
}

export interface FileWithSource {
  id: number;
  path: string;
  isVideo: boolean;
}

export interface CascadeFileResult {
  fileId: number;
  path: string;
  isVideo: boolean;
  season: number | null;
  episode: number | null;
  absoluteHint: number | null;
  airDate: string | null;
  stage: EpisodeStage | null;
}

export interface CascadeResult {
  torrentName: string;
  season: number | null;
  xOfY: TorrentParseResult['xOfY'];
  airDate: TorrentParseResult['airDate'];
  cleanedTitle: string;
  files: CascadeFileResult[];
}

/**
 * Run the 5-stage extractor cascade over a torrent's files.
 *
 * - Single-file torrents: parse the torrent name, ignore the file path.
 * - Multi-file torrents: parse each file path.
 * - Positional episodes are resolved after natural-sorting the remaining files.
 */
export function cascade(
  torrentName: string,
  files: FileWithSource[],
  config?: MaskConfig,
): CascadeResult {
  const torrentNameNormalised = normalise(torrentName);
  const torrentParse = parseTorrent(torrentName);

  const videoFiles = files.filter((f) => f.isVideo);
  const isSingleFile = videoFiles.length === 1;

  const parsedFiles: CascadeFileResult[] = videoFiles.map((file) => {
    const source = isSingleFile ? torrentNameNormalised : normalise(file.path);
    const parsed = parseEpisodeSource(source, torrentParse, config);

    return {
      fileId: file.id,
      path: file.path,
      isVideo: file.isVideo,
      season: parsed.season ?? torrentParse.season,
      episode: parsed.episode,
      absoluteHint: parsed.absoluteHint,
      airDate: parsed.airDate?.date ?? null,
      stage: parsed.stage,
    };
  });

  // Resolve positional episodes: natural sort, then index → episode.
  const positionalFiles = parsedFiles.filter((f) => f.stage === 'positional');
  const sorted = [...positionalFiles].sort((a, b) => naturalCompare(a.path, b.path));
  for (let i = 0; i < sorted.length; i++) {
    const file = sorted[i];
    if (file) {
      file.episode = i + 1;
    }
  }

  return {
    torrentName: torrentNameNormalised,
    season: torrentParse.season,
    xOfY: torrentParse.xOfY,
    airDate: torrentParse.airDate,
    cleanedTitle: torrentParse.cleanedTitle,
    files: parsedFiles,
  };
}
