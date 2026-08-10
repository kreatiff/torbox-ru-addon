import { logger } from '../logger.js';
import { getFeedEntryByTopicId, markDownloaded } from '../db/repositories/feedEntriesRepo.js';
import { upsertRule } from '../db/repositories/rulesRepo.js';
import { upsertTorrent } from '../db/repositories/torrentsRepo.js';
import { fetchMagnetLink } from '../rutracker/fetchMagnet.js';
import { parseFeedEntrySeasonEpisode } from '../rutracker/parseFeedEntryEpisode.js';
import { addTorrentMagnet } from '../torbox/client.js';

export type DownloadFeedEntryResult =
  | { ok: true; alreadyDownloaded: boolean; rawTitle: string }
  | { ok: false; error: string };

const MAGNET_HASH_REGEX = /btih:([a-f0-9]{40})/i;

/**
 * Pre-creates a rule for this torrent *before* it has any files in TorBox,
 * so that by the time the next ingest run discovers the torrent (via the
 * regular TorBox mylist poll) and rebuilds mappings for every existing rule
 * (rebuildAllMappings, unconditional, every run), the episode mapping falls
 * out immediately -- no LLM call, no manual step, no waiting.
 *
 * This works because we already have everything a rule needs *except* the
 * torrent's files, which `sequential` numbering doesn't need at rule-
 * creation time anyway (it just says "sort whatever files eventually show
 * up under this hash, starting from episode N"): the show (from the feed
 * entry's title_id, whether auto- or manually-matched), the season/episode
 * (parseFeedEntrySeasonEpisode on the raw title -- the same extraction the
 * "already in library" check already uses), and the torrent's info hash,
 * which BitTorrent magnet URIs carry directly (`btih:<hash>`) with no need
 * to wait for TorBox to actually cache anything.
 *
 * `rules.torrent_hash` has a foreign key to `torrents(hash)`, so the rule
 * can't be inserted until a `torrents` row exists -- seeded here via the
 * same `upsertTorrent` the real ingest uses, minimally (no size/cached/
 * added yet). That's not a workaround so much as reflecting reality a
 * little early: the torrent genuinely does exist in the TorBox account the
 * moment `addTorrentMagnet` succeeds, just not fully cached yet. The next
 * real ingest's own `upsertTorrent` call (ON CONFLICT DO UPDATE) fills in
 * total_size/cached_at/added_at/torbox_id once TorBox actually reports
 * them; `raw_name_at_ingest` is intentionally the feed's own title here --
 * more reliable than whatever name a freshly-added, metadata-unresolved
 * magnet might report -- and is never overwritten afterwards, matching the
 * existing "snapshot once" invariant everywhere else in this table.
 *
 * Best-effort and silent on any gap: no title match, no torbox_id in
 * TorBox's response, no season/episode parse, or no extractable hash just
 * means this torrent falls through to the normal ingest-time LLM
 * auto-proposal flow once it shows up as unruled, same as if this function
 * didn't exist. A wrong hash guess is equally harmless:
 * `listActiveUnruledTorrents()` excludes a torrent only when a rule's
 * torrent_hash matches its *real* hash exactly, so a mismatch just leaves
 * this pre-created rule (and its seed torrent row) unused and the torrent
 * still gets proposed normally -- never a silently wrong mapping, only a
 * missed optimization.
 */
async function preMapIfPossible(
  magnet: string,
  torboxHash: string | null,
  torboxTorrentId: number | null,
  titleId: string | null,
  rawTitle: string,
): Promise<void> {
  if (!titleId || !torboxTorrentId) {
    return;
  }
  const hash = (torboxHash ?? MAGNET_HASH_REGEX.exec(magnet)?.[1])?.toLowerCase();
  if (!hash) {
    logger.warn({ rawTitle }, 'Could not determine torrent hash for pre-mapping; skipping');
    return;
  }
  const { season, episode } = parseFeedEntrySeasonEpisode(rawTitle);
  if (season === null || episode === null) {
    return;
  }

  try {
    await upsertTorrent({
      hash,
      torboxId: torboxTorrentId,
      name: rawTitle,
      totalSize: null,
      cachedAt: null,
      addedAt: null,
    });
    await upsertRule({
      torrentHash: hash,
      titleId,
      season,
      numbering: 'sequential',
      sort: 'natural',
      startEpisode: episode,
      absoluteOffset: null,
      exceptions: {},
      confidence: 1.0,
      source: 'auto',
      proposalReason: 'Pre-mapped at download time from the RuTracker feed entry title',
      torrentName: rawTitle,
    });
    logger.info({ hash, titleId, season, episode }, 'pre-mapped torrent ahead of ingest');
  } catch (err) {
    // Never fail the download over this -- it's a nice-to-have, and the
    // torrent still gets a normal shot at auto-proposal once ingested.
    logger.warn({ err, hash, titleId }, 'Failed to pre-map torrent; will fall through to normal ingest');
  }
}

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

  let torboxHash: string | null;
  let torboxTorrentId: number | null;
  try {
    const added = await addTorrentMagnet(magnetResult.magnet);
    torboxHash = added.hash;
    torboxTorrentId = added.torrentId;
  } catch (err) {
    logger.error({ err, topicId }, 'Failed to add torrent to TorBox');
    return { ok: false, error: 'TorBox rejected the magnet link -- see server logs' };
  }

  await preMapIfPossible(magnetResult.magnet, torboxHash, torboxTorrentId, entry.titleId, entry.rawTitle);

  await markDownloaded(topicId);
  return { ok: true, alreadyDownloaded: false, rawTitle: entry.rawTitle };
}
