import { logger } from '../logger.js';
import { getMylist, getTorrentById, refreshWebdav } from '../torbox/client.js';
import { throttledMap } from '../torbox/rateLimit.js';
import type { TorboxFile, TorboxTorrent } from '../torbox/schemas.js';
import { listActiveUnruledTorrents, listKnownHashes, markAbsentGone, upsertTorrent } from '../db/repositories/torrentsRepo.js';
import { listVideoFilesForTorrent, upsertFiles, type UpsertFileInput } from '../db/repositories/filesRepo.js';
import { findOrCreateTitle, findTitleByCleanedName, type Title } from '../db/repositories/titlesRepo.js';
import { getProviderSeason, upsertProviderSeason } from '../db/repositories/providerSeasonsRepo.js';
import { parseTorrent } from '../extract/cascade.js';
import { normalise } from '../normalize/normalise.js';
import { proposeRule } from '../resolve/proposeRule.js';
import { upsertRule } from '../db/repositories/rulesRepo.js';
import { rebuildAllMappings, rebuildMappingsForRule } from './materialize.js';
import { isVideoFile } from './isVideoFile.js';
import type { TitleMatch } from '../resolve/confidence.js';
import { fetchExternalIds, fetchSeasonDetails, searchTitles } from '../metadata/tmdb.js';

export interface IngestSummary {
  webdavRefreshed: boolean;
  torrentsSeen: number;
  torrentsNew: number;
  torrentsMarkedGone: number;
  filesUpserted: number;
  perIdFetches: number;
  proposalsCreated: number;
  proposalsAutoCommitted: number;
  proposalsQueued: number;
  rulesRebuilt: number;
  rulesFailed: number;
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

/** Match a torrent's cleaned name to an existing title or a single confident
 * TMDB result. Keeps the title-match gate simple: exact/near-exact only,
 * no fuzzy NLP. If a unique existing title matches we reuse it; otherwise we
 * search TMDB and only accept if exactly one result matches the cleaned name. */
async function resolveTitleMatch(torrentName: string): Promise<TitleMatch | null> {
  const { cleanedTitle, season } = parseTorrent(torrentName);
  const existing = await findTitleByCleanedName(cleanedTitle);
  if (existing) {
    return toTitleMatch(existing, cleanedTitle, season ?? 1);
  }

  const tmdbResults = await searchTitles(cleanedTitle);
  const target = normalise(cleanedTitle).toLowerCase();
  const tmdbMatches = tmdbResults.filter((r) => {
    const ru = normalise(r.nameRu).toLowerCase();
    if (ru === target) return true;
    if (r.nameEn) {
      return normalise(r.nameEn).toLowerCase() === target;
    }
    return false;
  });
  if (tmdbMatches.length !== 1) {
    return null;
  }

  const [match] = tmdbMatches;
  if (!match) {
    return null;
  }
  let imdbId: string | null = null;
  let tvdbId: number | null = null;
  if (match.tmdbId) {
    try {
      const external = await fetchExternalIds(match.tmdbId);
      imdbId = external.imdbId;
      tvdbId = external.tvdbId;
    } catch (err) {
      logger.warn({ err, tmdbId: match.tmdbId }, 'Failed to fetch external ids for auto-proposed title');
    }
  }

  const created = await findOrCreateTitle({
    imdbId,
    tvdbId,
    tmdbId: match.tmdbId,
    nameRu: match.nameRu,
    nameEn: match.nameEn ?? null,
    year: match.year ?? null,
    aliases: [],
    posterUrl: match.posterUrl ?? null,
  });

  return toTitleMatch(created, cleanedTitle, season ?? 1);
}

async function toTitleMatch(
  title: Title,
  cleanedTitle: string,
  season: number,
): Promise<TitleMatch> {
  const tmdbSeasons = await fetchTmdbSeason(title.id, title.tmdbId, season);
  return {
    titleId: title.id,
    nameRu: title.nameRu,
    nameEn: title.nameEn,
    seasons: tmdbSeasons,
  };
}

async function fetchTmdbSeason(
  titleId: string,
  tmdbId: number | null,
  season: number,
): Promise<TitleMatch['seasons']> {
  if (!tmdbId) {
    return [];
  }
  const cached = await getProviderSeason(titleId, season, 'tmdb');
  if (cached) {
    return [
      {
        season: cached.season,
        episode_count: cached.episode_count,
        episodes: cached.episodes.map((e) => ({ episode: e.episode, air_date: e.air_date ?? null })),
      },
    ];
  }
  try {
    const episodes = await fetchSeasonDetails(tmdbId, season);
    if (episodes.length > 0) {
      const saved = await upsertProviderSeason({
        title_id: titleId,
        season,
        source: 'tmdb',
        episode_count: episodes.length,
        episodes: episodes.map((e) => ({ episode: e.episode, air_date: e.air_date ?? null })),
      });
      return [
        {
          season: saved.season,
          episode_count: saved.episode_count,
          episodes: saved.episodes.map((e) => ({ episode: e.episode, air_date: e.air_date ?? null })),
        },
      ];
    }
  } catch (err) {
    logger.warn({ err, titleId, tmdbId, season }, 'Failed to fetch TMDB season for auto-proposed title');
  }
  return [];
}

/**
 * Milestone 1+2 scope: refresh -> fetch -> upsert torrents -> fetch files
 * for new hashes -> mark absent gone -> rebuild mappings for every existing
 * rule. "Propose rules for unruled torrents" (§5.2) still doesn't run here —
 * that needs the extractor cascade (Milestone 5) — so the rebuild step only
 * ever processes rules that already exist: hand-inserted ones for now
 * (Milestone 2), UI-authored ones from Milestone 4 on. Not on a schedule yet
 * either (Milestone 6); call this directly.
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

  // Milestone 5: propose rules for active torrents that still have no rule.
  const unruled = await listActiveUnruledTorrents();
  let proposalsCreated = 0;
  let proposalsAutoCommitted = 0;
  let proposalsQueued = 0;
  for (const torrent of unruled) {
    const titleMatch = await resolveTitleMatch(torrent.rawNameAtIngest);
    const files = await listVideoFilesForTorrent(torrent.hash);
    if (files.length === 0) {
      logger.info({ hash: torrent.hash }, 'skipping proposal: no video files');
      continue;
    }

    const proposal = proposeRule(
      { hash: torrent.hash, rawNameAtIngest: torrent.rawNameAtIngest },
      files,
      titleMatch,
    );

    try {
      const saved = await upsertRule(proposal);
      proposalsCreated++;

      if (titleMatch && proposal.confidence >= 0.45) {
        try {
          await rebuildMappingsForRule(saved.id);
          proposalsAutoCommitted++;
        } catch (err) {
          logger.warn({ err, hash: torrent.hash }, 'auto-proposed rule accepted but rebuild failed');
          proposalsQueued++;
        }
      } else {
        proposalsQueued++;
      }
    } catch (err) {
      logger.warn({ err, hash: torrent.hash }, 'failed to persist auto-proposed rule');
    }
  }
  if (proposalsCreated > 0) {
    logger.info({ proposalsCreated, proposalsAutoCommitted, proposalsQueued }, 'auto-proposals processed');
  }

  const { rulesProcessed: rulesRebuilt, rulesFailed } = await rebuildAllMappings();
  if (rulesRebuilt > 0 || rulesFailed > 0) {
    logger.info({ rulesRebuilt, rulesFailed }, 'mappings rebuilt for existing rules');
  }

  const summary: IngestSummary = {
    webdavRefreshed,
    torrentsSeen: mylist.length,
    torrentsNew: newTorrents.length,
    torrentsMarkedGone,
    filesUpserted,
    perIdFetches: needingFetch.length,
    proposalsCreated,
    proposalsAutoCommitted,
    proposalsQueued,
    rulesRebuilt,
    rulesFailed,
  };
  logger.info(summary, 'ingest run complete');
  return summary;
}
