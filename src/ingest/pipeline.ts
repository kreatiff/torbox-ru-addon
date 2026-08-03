import { logger } from '../logger.js';
import { getMylist, getTorrentById, refreshWebdav } from '../torbox/client.js';
import { throttledMap } from '../torbox/rateLimit.js';
import type { TorboxFile, TorboxTorrent } from '../torbox/schemas.js';
import { listKnownHashes, markAbsentGone, upsertTorrent } from '../db/repositories/torrentsRepo.js';
import { upsertFiles, type UpsertFileInput } from '../db/repositories/filesRepo.js';
import { isVideoFile } from './isVideoFile.js';

export interface IngestSummary {
  webdavRefreshed: boolean;
  torrentsSeen: number;
  torrentsNew: number;
  torrentsMarkedGone: number;
  filesUpserted: number;
  perIdFetches: number;
}

function toUpsertFileInputs(torrentHash: string, files: TorboxFile[]): UpsertFileInput[] {
  return files.map((f) => ({
    torrentHash,
    torboxFileId: f.id,
    rawPath: f.name,
    size: f.size,
    isVideo: isVideoFile(f.name),
  }));
}

/**
 * Milestone 1 scope only: refresh -> fetch -> upsert torrents -> fetch files
 * for new hashes -> mark absent gone. Deliberately stops there — proposing
 * rules and rebuilding mappings needs src/resolve, which doesn't exist yet
 * (Milestone 5, per the locked build order). Not on a schedule yet either
 * (Milestone 6); call this directly.
 */
export async function runIngest(): Promise<IngestSummary> {
  const webdavRefreshed = await refreshWebdav();
  logger.info({ webdavRefreshed }, 'webdav refresh attempted');

  // Must be captured before upserting this run's batch: a torrent's file
  // list can't change once ingested (the hash IS a content hash), so
  // "known before this run" is exactly the set that should NOT trigger a
  // files fetch, regardless of whether it's currently active or gone.
  const knownHashesBefore = await listKnownHashes();

  const mylist: TorboxTorrent[] = await getMylist();
  if (mylist.length === 0) {
    logger.warn(
      'mylist returned zero torrents. Not marking anything gone this run — verify this is a real empty ' +
        'library and not an auth problem (TorBox returns success:true with an empty array here, which ' +
        'parseEnvelope cannot distinguish from a real empty library on its own).',
    );
  }

  for (const torrent of mylist) {
    await upsertTorrent({
      hash: torrent.hash,
      torboxId: torrent.id,
      name: torrent.name,
      totalSize: torrent.size ?? null,
      cachedAt: torrent.cached_at ?? null,
      addedAt: torrent.created_at ?? null,
    });
  }
  logger.info({ count: mylist.length }, 'torrents upserted');

  const newTorrents = mylist.filter((t) => !knownHashesBefore.has(t.hash));
  const withInlineFiles = newTorrents.filter((t) => t.files !== undefined);
  const needingFetch = newTorrents.filter((t) => t.files === undefined);

  let filesUpserted = 0;

  for (const torrent of withInlineFiles) {
    const upserted = await upsertFiles(toUpsertFileInputs(torrent.hash, torrent.files ?? []));
    filesUpserted += upserted.length;
  }

  await throttledMap(needingFetch, async (torrent) => {
    const full = await getTorrentById(torrent.id);
    const upserted = await upsertFiles(toUpsertFileInputs(torrent.hash, full.files ?? []));
    filesUpserted += upserted.length;
  });

  if (needingFetch.length > 0) {
    logger.info(
      { count: needingFetch.length },
      'mylist omitted files for some new torrents; fetched per-torrent via ?id=',
    );
  }

  // Only torrents actually present in this successful mylist response count
  // as "present" — mylist.length === 0 already warned above and still runs
  // this, but markAbsentGone's own empty-list guard makes that call a no-op
  // rather than a wipe.
  const presentHashes = mylist.map((t) => t.hash);
  const torrentsMarkedGone = await markAbsentGone(presentHashes);
  if (torrentsMarkedGone > 0) {
    logger.info(
      { count: torrentsMarkedGone },
      'torrents marked gone (absent from this mylist response)',
    );
  }

  const summary: IngestSummary = {
    webdavRefreshed,
    torrentsSeen: mylist.length,
    torrentsNew: newTorrents.length,
    torrentsMarkedGone,
    filesUpserted,
    perIdFetches: needingFetch.length,
  };
  logger.info(summary, 'ingest run complete');
  return summary;
}
