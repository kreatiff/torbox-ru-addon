import { logger } from '../logger.js';
import { getFeedEntryByTopicId, markDownloaded } from '../db/repositories/feedEntriesRepo.js';
import { fetchMagnetLink } from '../rutracker/fetchMagnet.js';
import { addTorrentMagnet } from '../torbox/client.js';

export type DownloadFeedEntryResult =
  | { ok: true; alreadyDownloaded: boolean; rawTitle: string }
  | { ok: false; error: string };

/**
 * Core logic behind the manual "Download" action (admin UI button + Discord
 * notification link) -- resolves a feed_entries row's magnet link via
 * FlareSolverr, then adds it to TorBox. Idempotent: a topic already marked
 * downloaded short-circuits without re-contacting FlareSolverr or TorBox, so
 * a second click (or a re-clicked Discord link) is harmless rather than
 * launching another FlareSolverr Chromium instance or double-adding the
 * torrent.
 */
export async function downloadFeedEntry(topicId: number): Promise<DownloadFeedEntryResult> {
  const entry = await getFeedEntryByTopicId(topicId);
  if (!entry) {
    return { ok: false, error: `No feed entry found for topic ${topicId}` };
  }
  if (entry.downloadedAt) {
    return { ok: true, alreadyDownloaded: true, rawTitle: entry.rawTitle };
  }

  const magnetResult = await fetchMagnetLink(entry.url);
  if (!magnetResult.ok) {
    return { ok: false, error: magnetResult.error };
  }

  try {
    await addTorrentMagnet(magnetResult.magnet);
  } catch (err) {
    logger.error({ err, topicId }, 'Failed to add torrent to TorBox');
    return { ok: false, error: 'TorBox rejected the magnet link -- see server logs' };
  }

  await markDownloaded(topicId);
  return { ok: true, alreadyDownloaded: false, rawTitle: entry.rawTitle };
}
