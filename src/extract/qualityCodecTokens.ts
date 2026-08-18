// Spec §3.2: quality/codec/release-group tokens that should be masked
// before bare-number episode extraction runs.

export const defaultQualityCodecTokens = [
  '1080p',
  '1080i',
  '720p',
  '480p',
  '2160p',
  '4k',
  'hdtv',
  'hdrip',
  'webrip',
  'web-dl',
  'webdl',
  'bdrip',
  'brrip',
  'dvdrip',
  'x264',
  'x265',
  'h.264',
  'h.265',
  'h264',
  'h265',
  'hevc',
  'avc',
  'aac',
  'ac3',
  'dts',
  'dd5.1',
  '5.1',
  '2.0',
  'mp4',
  'mkv',
  'ts',
  'avi',
];

export const defaultReleaseGroups = [
  'Files-x',
  'Nicodem',
];

export interface MaskConfig {
  qualityCodecTokens: string[];
  releaseGroups: string[];
}

export const defaultMaskConfig: MaskConfig = {
  qualityCodecTokens: defaultQualityCodecTokens,
  releaseGroups: defaultReleaseGroups,
};

/** Builds a regex that matches quality/codec tokens as whole words. */
export function buildQualityCodecRegex(config: MaskConfig = defaultMaskConfig): RegExp {
  const tokens = config.qualityCodecTokens.map(escapeRegex);
  return new RegExp(`\\b(?:${tokens.join('|')})\\b`, 'gi');
}

/** Builds a regex that matches release-group markers. */
export function buildReleaseGroupRegex(config: MaskConfig = defaultMaskConfig): RegExp {
  const groups = config.releaseGroups.map(escapeRegex);
  // "by.Nicodem" and literal group names
  return new RegExp(`(?:by\\.\\w+|${groups.join('|')})`, 'gi');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
