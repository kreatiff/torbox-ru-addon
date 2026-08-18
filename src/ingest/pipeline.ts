import { config } from '../config.js';
import { logger } from '../logger.js';
import { getMylist, getTorrentById, refreshWebdav } from '../torbox/client.js';
import { throttledMap } from '../torbox/rateLimit.js';
import type { TorboxFile, TorboxTorrent } from '../torbox/schemas.js';
import {
  listActiveUnruledTorrents,
  listKnownHashes,
  markAbsentGone,
  markFilesFetched,
  upsertTorrent,
} from '../db/repositories/torrentsRepo.js';
import {
  listVideoFilesForTorrent,
  upsertFiles,
  type UpsertFileInput,
} from '../db/repositories/filesRepo.js';
import {
  findOrCreateTitle,
  findTitleByCleanedName,
  listAll as listAllTitles,
  type Title,
} from '../db/repositories/titlesRepo.js';
import { getProviderSeason, upsertProviderSeason } from '../db/repositories/providerSeasonsRepo.js';
import {
  filterExistingTopicIds,
  upsertFeedEntry,
  listUnnotifiedEntries,
  markNotified,
} from '../db/repositories/feedEntriesRepo.js';
import {
  notifyDiscordNewMatches,
  notifyDiscordEpisodesProcessed,
  formatEpisodeRange,
  type ProcessedEpisodeNotification,
} from '../notify/discord.js';
import { logActivity } from '../db/repositories/activityLogRepo.js';
import { proposeRule } from '../resolve/proposeRule.js';
import { upsertRule } from '../db/repositories/rulesRepo.js';
import { rebuildAllMappings, rebuildMappingsForRule } from './materialize.js';
import { isVideoFile } from './isVideoFile.js';
import type { TitleMatch } from '../resolve/confidence.js';
import {
  fetchExternalIds,
  fetchSeasonDetails,
  searchTitles,
  type TmdbSearchResult,
} from '../metadata/tmdb.js';
import { extractEpisodes, type LlmExtraction } from '../llm/opencodeZen.js';
import { fetchFeed, matchEntries } from '../rutracker/index.js';

export interface IngestSummary {
  webdavRefreshed: boolean;
  torrentsSeen: number;
  torrentsNew: number;
  torrentsMarkedGone: number;
  filesUpserted: number;
  perIdFetches: number;
  perIdFetchesFailed: number;
  feedEntriesMatched: number;
  feedEntriesNew: number;
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

export interface TitleResolution {
  title: Title;
  titleMatch: TitleMatch;
}

/**
 * Resolves the LLM's title/season guess to an existing title row or a TMDB
 * result. If a known title matches (by name or alias) we reuse it;
 * otherwise we search TMDB and take the best candidate -- deliberately
 * *not* an exact-string match against the LLM's guess: TMDB's own search
 * ranking already does fuzzy matching, and requiring string equality here
 * is exactly what broke title resolution under the old regex-cascade flow
 * (site-tag prefixes and leftover phrase fragments in a hand-cleaned title
 * never matched anything, even when the show and season were obvious to a
 * human). Returns null only when TMDB has no results at all for the guess.
 *
 * Returns the full `Title` row alongside the narrower `TitleMatch` (used by
 * `proposeRule`'s provider-season cross-check) so callers that need to show
 * a human the matched show -- e.g. the per-torrent preview endpoint -- have
 * `tmdbId`/`year`/`posterUrl` without a second lookup.
 *
 * Only creates a *new* title when TMDB's best match is Russian-language
 * content (`original_language === 'ru'`) -- this is a Russian-tracker
 * addon, and nothing upstream of this function (the LLM prompt, the TMDB
 * search call) actually checks content language, so without this gate a
 * confidently-extracted English show/torrent on RuTracker gets auto-added
 * to the library exactly like a real one. A non-Russian best match is
 * treated the same as "no match at all" -- the torrent still queues for
 * manual review, it just never becomes a new title. The existing-title
 * fast path above isn't re-gated: a title already in the library either
 * predates this check or was vetted by a human.
 */
export async function resolveTitleMatch(llm: LlmExtraction): Promise<TitleResolution | null> {
  const existing =
    (await findTitleByCleanedName(llm.title)) ??
    (llm.titleEn ? await findTitleByCleanedName(llm.titleEn) : null);
  if (existing) {
    return { title: existing, titleMatch: await toTitleMatch(existing, llm.season) };
  }

  // Same title-then-titleEn fallback as the DB lookup above: a
  // Russian-only LLM title can miss on TMDB (e.g. an obscure or
  // differently-transliterated Russian search term) even when the
  // English title would have matched cleanly.
  let tmdbResults = await searchTitles(llm.title);
  if (tmdbResults.length === 0 && llm.titleEn) {
    tmdbResults = await searchTitles(llm.titleEn);
  }
  const match = pickBestTmdbMatch(tmdbResults, llm.year);
  if (!match) {
    return null;
  }
  if (match.originalLanguage !== 'ru') {
    logger.info(
      { tmdbId: match.tmdbId, name: match.nameRu, originalLanguage: match.originalLanguage },
      'Skipping auto-match: best TMDB result is not Russian-language content',
    );
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
      logger.warn(
        { err, tmdbId: match.tmdbId },
        'Failed to fetch external ids for auto-proposed title',
      );
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

  return { title: created, titleMatch: await toTitleMatch(created, llm.season) };
}

/** When the LLM gave a year, prefer TMDB's top result whose year matches
 * it; otherwise trust TMDB's own top-ranked result. Null only when TMDB
 * returned zero results. */
function pickBestTmdbMatch(
  results: TmdbSearchResult[],
  year: number | null,
): TmdbSearchResult | null {
  if (results.length === 0) {
    return null;
  }
  if (year !== null) {
    const yearMatch = results.find((r) => r.year === year);
    if (yearMatch) {
      return yearMatch;
    }
  }
  return results[0] ?? null;
}

async function toTitleMatch(title: Title, season: number): Promise<TitleMatch> {
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
        episodes: cached.episodes.map((e) => ({
          episode: e.episode,
          air_date: e.air_date ?? null,
        })),
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
          episodes: saved.episodes.map((e) => ({
            episode: e.episode,
            air_date: e.air_date ?? null,
          })),
        },
      ];
    }
  } catch (err) {
    logger.warn(
      { err, titleId, tmdbId, season },
      'Failed to fetch TMDB season for auto-proposed title',
    );
  }
  return [];
}

/**
 * RuTracker feed scraper (docs/rutracker-scraper-plan.md): poll the
 * configured Atom feed(s), match entries against the library, and upsert
 * matched entries into feed_entries. Unmatched entries are dropped unless
 * RUTRACKER_STORE_UNMATCHED is set, keeping the table library-scoped and
 * bounded. Purely observational -- never touches torrents/rules/mappings.
 */
async function pollFeed(): Promise<{ feedEntriesMatched: number; feedEntriesNew: number }> {
  const feedEntries = await fetchFeed();
  if (feedEntries.length === 0) {
    return { feedEntriesMatched: 0, feedEntriesNew: 0 };
  }

  const titles = await listAllTitles();
  const matched = matchEntries(feedEntries, titles);
  const matchedTopicIds = new Set(matched.map((m) => m.entry.topicId));

  const toStore = matched.map((m) => ({ entry: m.entry, titleId: m.title.id as string | null }));
  if (config.rutrackerStoreUnmatched) {
    for (const entry of feedEntries) {
      if (!matchedTopicIds.has(entry.topicId)) {
        toStore.push({ entry, titleId: null });
      }
    }
  }

  const existingTopicIds = await filterExistingTopicIds(toStore.map((s) => s.entry.topicId));
  let feedEntriesNew = 0;
  for (const { entry, titleId } of toStore) {
    if (!existingTopicIds.has(entry.topicId)) {
      feedEntriesNew++;
    }
    await upsertFeedEntry({
      topicId: entry.topicId,
      titleId,
      rawTitle: entry.rawTitle,
      url: entry.url,
      lastUpdated: entry.updatedAt,
    });
  }

  // Discord notification: reuses notified_at exactly as designed (see the
  // feed_entries migration) -- picks up brand-new matched rows from this
  // run, plus any row that failed to notify on a previous run (retry-safe).
  // Every processed row is marked notified, matched or not, so unmatched
  // junk (only ever stored when RUTRACKER_STORE_UNMATCHED is set) isn't
  // reconsidered on every run -- but only matched rows actually get a
  // Discord message.
  const unnotified = await listUnnotifiedEntries();
  if (unnotified.length > 0) {
    const toNotify = unnotified.filter((e) => e.titleId !== null);
    await notifyDiscordNewMatches(toNotify);

    const titleNameById = new Map(titles.map((t) => [t.id, t.nameRu]));
    for (const entry of toNotify) {
      const titleName = entry.titleId ? titleNameById.get(entry.titleId) : undefined;
      await logActivity(
        'rutracker',
        titleName ? `Matched "${entry.rawTitle}" to ${titleName}.` : `Matched "${entry.rawTitle}".`,
      );
    }

    await markNotified(unnotified.map((e) => e.topicId));
  }

  logger.info(
    { feedEntriesSeen: feedEntries.length, feedEntriesMatched: matched.length, feedEntriesNew },
    'feed poll complete',
  );
  return { feedEntriesMatched: matched.length, feedEntriesNew };
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
  // "already had its files fetched before this run" is exactly the set that
  // should NOT trigger another files fetch, regardless of whether it's
  // currently active or gone. Keyed on files_fetched_at, not mere row
  // presence in `torrents` -- a torrent can have a row (e.g. seeded early by
  // downloadFeedEntry's preMapIfPossible) without ever having had its files
  // fetched yet.
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
    await markFilesFetched([torrent.hash]);
  }

  let perTorrentFetchFailures = 0;
  await throttledMap(needingFetch, async (torrent) => {
    // Isolated per torrent, same idiom as the auto-proposal loop below: one
    // torrent's fetch failing (a schema mismatch, a transient network
    // error) must not abort the rest of this run -- mark-gone, the feed
    // poll, and auto-proposals all still need to happen this cycle. A
    // failed torrent is simply left with files_fetched_at unset, so
    // `needingFetch` picks it up again on the next run.
    try {
      const full = await getTorrentById(torrent.id);
      const upserted = await upsertFiles(toUpsertFileInputs(torrent.hash, full.files ?? []));
      filesUpserted += upserted.length;
      await markFilesFetched([torrent.hash]);
    } catch (err) {
      perTorrentFetchFailures++;
      logger.warn(
        { err, hash: torrent.hash, torboxId: torrent.id },
        'failed to fetch/store files for one torrent; will retry next run',
      );
    }
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

  // RuTracker feed scraper (docs/rutracker-scraper-plan.md): purely
  // observational, additive. fetchFeed() never throws (see its own
  // comments), so a RuTracker outage can't take the rest of this run down.
  const { feedEntriesMatched, feedEntriesNew } = await pollFeed();

  // Milestone 5 (now LLM-based, see docs/decisions.md): propose rules for
  // active torrents that still have no rule. Throttled at
  // OPENCODE_ZEN_REQUEST_DELAY_MS, same pattern as the TorBox per-file
  // fetch above -- free-tier LLM rate limits are a real near-term risk.
  const unruled = await listActiveUnruledTorrents();
  let proposalsCreated = 0;
  let proposalsAutoCommitted = 0;
  let proposalsQueued = 0;
  // Populated only for auto-committed (tier: 'commit') proposals -- a
  // queued one isn't "processed and added to the library" yet, it's just
  // sitting in the Queue awaiting a human. Notified once, after the whole
  // batch finishes, same batching style as pollFeed's Discord notification.
  const processedForNotification: ProcessedEpisodeNotification[] = [];

  await throttledMap(
    unruled,
    async (torrent) => {
      const files = await listVideoFilesForTorrent(torrent.hash);
      if (files.length === 0) {
        logger.info({ hash: torrent.hash }, 'skipping proposal: no video files');
        return;
      }

      let llm: LlmExtraction | null = null;
      try {
        llm = await extractEpisodes(
          torrent.rawNameAtIngest,
          files.map((f) => ({ fileId: f.id, path: f.rawPath, size: f.size })),
        );
      } catch (err) {
        logger.warn(
          { err, hash: torrent.hash },
          'LLM extraction failed, queuing for manual review',
        );
      }

      const resolution = llm ? await resolveTitleMatch(llm) : null;

      const { proposal, tier } = proposeRule(
        { hash: torrent.hash, rawNameAtIngest: torrent.rawNameAtIngest },
        files,
        resolution?.titleMatch ?? null,
        llm,
      );

      try {
        const saved = await upsertRule(proposal);
        proposalsCreated++;

        // Materialise mappings for a committed proposal only -- a queued
        // one must stay inert (visible in the Queue, no streams) until a
        // human accepts it. See docs/decisions.md.
        if (tier === 'commit') {
          try {
            const mappings = await rebuildMappingsForRule(saved.id);
            proposalsAutoCommitted++;

            const titleName =
              resolution?.title.nameRu ?? proposal.torrentName ?? torrent.rawNameAtIngest;
            const episodesBySeason = new Map<number, Set<number>>();
            for (const m of mappings) {
              const episodes = episodesBySeason.get(m.season) ?? new Set<number>();
              episodes.add(m.episode);
              episodesBySeason.set(m.season, episodes);
            }
            for (const [season, episodes] of episodesBySeason) {
              const episodeList = [...episodes];
              processedForNotification.push({ titleName, season, episodes: episodeList });
              await logActivity(
                'torbox',
                `${titleName} — ${formatEpisodeRange(season, episodeList)} processed and added to the library.`,
              );
            }
          } catch (err) {
            logger.warn(
              { err, hash: torrent.hash },
              'auto-proposed rule accepted but rebuild failed',
            );
            proposalsQueued++;
          }
        } else {
          proposalsQueued++;
        }
      } catch (err) {
        logger.warn({ err, hash: torrent.hash }, 'failed to persist auto-proposed rule');
      }
    },
    config.opencodeZenRequestDelayMs,
  );
  if (proposalsCreated > 0) {
    logger.info(
      { proposalsCreated, proposalsAutoCommitted, proposalsQueued },
      'auto-proposals processed',
    );
  }

  if (processedForNotification.length > 0) {
    await notifyDiscordEpisodesProcessed(processedForNotification);
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
    perIdFetchesFailed: perTorrentFetchFailures,
    feedEntriesMatched,
    feedEntriesNew,
    proposalsCreated,
    proposalsAutoCommitted,
    proposalsQueued,
    rulesRebuilt,
    rulesFailed,
  };
  logger.info(summary, 'ingest run complete');
  return summary;
}

let ingestInFlight: Promise<IngestSummary> | null = null;

/**
 * Coalescing wrapper around runIngest() -- the single entry point every
 * trigger source goes through (the scheduler in ./scheduler.ts, the TorBox
 * webhook in src/http/routes/webhooks, and the admin "run now" button at
 * POST /api/ingest/run) so overlapping triggers can never run runIngest()
 * concurrently. Triggers can genuinely race: a webhook notification can
 * land the same moment the scheduler ticks, or an admin can click "run now"
 * mid-run. A call while a run is already in flight just returns that run's
 * promise instead of starting a concurrent one; runIngest() isn't designed
 * to be re-entrant (e.g. two runs racing to mark the same torrent gone, or
 * duplicate LLM extraction calls racing upsertRule).
 */
export function runIngestDeduped(): Promise<IngestSummary> {
  if (ingestInFlight) {
    return ingestInFlight;
  }
  ingestInFlight = runIngest().finally(() => {
    ingestInFlight = null;
  });
  return ingestInFlight;
}
