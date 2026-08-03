import type { Mapping } from '../resolve/types.js';
import type { FileWithTorrent } from '../db/repositories/filesRepo.js';
import { config } from '../config.js';

export interface StremioStream {
  name: string;
  description: string;
  url: string;
  behaviorHints: {
    bingeGroup: string;
    notWebReady: boolean;
  };
}

function prettySize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function isNotWebReady(rawPath: string): boolean {
  const ext = rawPath.split('.').pop()?.toLowerCase() ?? '';
  return config.notWebReadyExtensions.includes(ext);
}

/**
 * Combines materialised mappings with their file/torrent info and each
 * mapping's rule confidence into Stremio Stream objects (§5.5). A mapping
 * with no matching entry in `filesById` is skipped rather than thrown on --
 * shouldn't happen (mappings.file_id cascades on delete) but the file join
 * is a separate query, so handled defensively rather than assumed.
 */
export function buildStreams(
  mappings: Mapping[],
  filesById: Map<number, FileWithTorrent>,
  confidenceByRuleId: Map<string, number>,
): StremioStream[] {
  const streams: StremioStream[] = [];
  for (const mapping of mappings) {
    const file = filesById.get(mapping.fileId);
    if (!file) {
      continue;
    }
    const confidence = confidenceByRuleId.get(mapping.ruleId) ?? 1;
    const lowConfidence = confidence < 1;
    const torrentDisplayName = file.torrentDisplayName ?? file.rawPath;
    streams.push({
      name: 'TorBox RU',
      description: `${torrentDisplayName}\n${prettySize(file.size)}${lowConfidence ? ' ⚠' : ''}`,
      url: `${config.publicBase}/${config.addonToken}/play/${file.id}`,
      behaviorHints: {
        bingeGroup: `torbox-ru-${mapping.titleId}-${mapping.season}`,
        notWebReady: isNotWebReady(file.rawPath),
      },
    });
  }
  return streams;
}
