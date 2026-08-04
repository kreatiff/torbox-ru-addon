import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../../db/pool.js';
import { verifyBasicAuth } from '../../hooks/verifyBasicAuth.js';
import {
  findOrCreateTitle,
  listTitlesWithSeasons,
  upsertRule,
  upsertProviderSeason,
  getProviderSeason,
  getRuleById,
  deleteRule,
} from '../../../db/repositories/index.js';
import { searchTitles, fetchExternalIds, fetchSeasonDetails } from '../../../metadata/tmdb.js';
import { runIngest } from '../../../ingest/pipeline.js';
import { rebuildMappingsForRule } from '../../../ingest/materialize.js';
import { naturalCompare } from '../../../extract/naturalSort.js';

const saveRuleBodySchema = z.object({
  torrentHash: z.string(),
  season: z.number().int().positive(),
  numbering: z.enum(['sequential', 'parsed', 'continuous', 'manual']),
  sort: z.enum(['natural', 'path']),
  startEpisode: z.number().int().positive().default(1),
  absoluteOffset: z.number().int().nullable().optional(),
  exceptions: z
    .record(
      z.string(),
      z.union([
        z.literal('ignore'),
        z.object({ season: z.number().int(), episode: z.number().int() }),
      ]),
    )
    .default({}),
  title: z
    .object({
      tmdbId: z.number().int().optional().nullable(),
      nameRu: z.string(),
      nameEn: z.string().optional().nullable(),
      year: z.number().int().optional().nullable(),
      posterUrl: z.string().optional().nullable(),
      imdbId: z.string().optional().nullable(),
      tvdbId: z.number().int().optional().nullable(),
    })
    .optional(),
  titleId: z.string().optional(),
  // Set when editing an already-mapped rule from the Library view (as
  // opposed to creating a fresh one from the Queue) -- lets the handler
  // below clean up the old row if the edit also changed the season.
  ruleId: z.string().optional(),
  torrentName: z.string().optional(),
});

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // Gated by Basic Auth for all /api endpoints
  app.addHook('onRequest', verifyBasicAuth);

  // GET /api/queue - Torrents needing review
  app.get('/queue', async (_request, _reply) => {
    const result = await pool.query(
      `select t.hash, t.raw_name_at_ingest, t.first_seen, count(f.id) as file_count,
              r.id as rule_id, r.season as rule_season, r.numbering as rule_numbering,
              r.confidence as rule_confidence, r.proposal_reason, r.torrent_name
       from torrents t
       left join files f on f.torrent_hash = t.hash and f.is_video = true
       left join rules r on r.torrent_hash = t.hash
       where t.status = 'active'
         and (r.id is null or (r.source = 'auto' and (r.title_id is null or r.confidence < 0.45)))
       group by t.hash, r.id
       order by t.first_seen desc`,
    );

    const queueItems = result.rows.map((row) => {
      const name = row.raw_name_at_ingest;
      let proposedTitle = name;
      const proposedSeason = row.rule_season ?? 1;

      // Basic fallback show/season proposal using regex heuristics
      const cleanName = name.replace(/\[.*?\]/g, '').trim();
      const seasonMatch = cleanName.match(/(\d+)\s*(сезон|season)/i);
      if (seasonMatch && seasonMatch[1]) {
        proposedTitle = cleanName.replace(seasonMatch[0], '').trim();
      }
      proposedTitle = proposedTitle.replace(/\s+/g, ' ').trim();

      return {
        hash: row.hash,
        rawNameAtIngest: name,
        firstSeen: row.first_seen,
        fileCount: parseInt(row.file_count, 10),
        ruleId: row.rule_id ?? null,
        proposal: {
          proposedTitle: row.proposal_reason ? row.torrent_name ?? proposedTitle : proposedTitle,
          proposedSeason,
          confidence: row.rule_confidence ?? 0.1,
          why: row.proposal_reason ?? 'Proposal engine not run yet (Milestone 5). Text-extracted defaults.',
          numbering: row.rule_numbering ?? 'parsed',
        },
      };
    });

    return queueItems;
  });

  // GET /api/torrents/:hash - Get files for torrent
  app.get('/torrents/:hash', async (request, reply) => {
    const { hash } = request.params as { hash: string };

    const torrentResult = await pool.query('select * from torrents where hash = $1', [hash]);
    const torrent = torrentResult.rows[0];
    if (!torrent) {
      return reply.code(404).send({ error: 'Torrent not found' });
    }

    const filesResult = await pool.query(
      'select id, raw_path, size, is_video, mount_path from files where torrent_hash = $1',
      [hash],
    );

    // Natural sort in JS to respect layout flow
    const sortedFiles = filesResult.rows
      .map((row) => ({
        id: parseInt(row.id, 10),
        rawPath: row.raw_path,
        size: parseInt(row.size, 10),
        isVideo: row.is_video,
        mountPath: row.mount_path,
      }))
      .sort((a, b) => naturalCompare(a.rawPath, b.rawPath));

    // Existing rules for this torrent (if any), with their title joined in --
    // lets the Labeller UI pre-fill an edit form instead of only supporting
    // fresh rules for not-yet-mapped torrents from the Queue.
    const rulesResult = await pool.query(
      `select r.id, r.season, r.numbering, r.sort, r.start_episode, r.absolute_offset, r.exceptions,
              t.id as title_id, t.tmdb_id, t.imdb_id, t.tvdb_id, t.name_ru, t.name_en, t.year, t.poster_url
       from rules r
       join titles t on t.id = r.title_id
       where r.torrent_hash = $1
       order by r.season`,
      [hash],
    );
    const rules = rulesResult.rows.map((row) => ({
      id: row.id,
      season: row.season,
      numbering: row.numbering,
      sort: row.sort,
      startEpisode: row.start_episode,
      absoluteOffset: row.absolute_offset,
      exceptions: row.exceptions,
      title: {
        id: row.title_id,
        tmdbId: row.tmdb_id,
        imdbId: row.imdb_id,
        tvdbId: row.tvdb_id,
        nameRu: row.name_ru,
        nameEn: row.name_en,
        year: row.year,
        posterUrl: row.poster_url,
      },
    }));

    return {
      hash: torrent.hash,
      rawNameAtIngest: torrent.raw_name_at_ingest,
      status: torrent.status,
      files: sortedFiles,
      rules,
    };
  });

  // GET /api/titles/search - Search TMDB
  app.get('/titles/search', async (request, _reply) => {
    const { query } = request.query as { query?: string };
    if (!query) {
      return [];
    }
    const results = await searchTitles(query);
    return results;
  });

  // POST /api/rules - Create or update manual rule
  app.post('/rules', async (request, reply) => {
    const body = saveRuleBodySchema.parse(request.body);

    // 'parsed' is now implemented (Milestone 5). It needs a stored torrent_name
    // so expandRule can re-run the extractor cascade; when a human edits an
    // existing rule we copy it from the raw ingest snapshot.
    let torrentName = body.torrentName;
    if (body.numbering === 'parsed' && !torrentName) {
      const torrentResult = await pool.query(
        'select raw_name_at_ingest from torrents where hash = $1',
        [body.torrentHash],
      );
      torrentName = torrentResult.rows[0]?.raw_name_at_ingest ?? null;
      if (!torrentName) {
        return reply.code(400).send({
          error: "numbering 'parsed' requires the torrent name to be available",
        });
      }
    }

    let titleId = body.titleId;

    // Create show if missing
    if (!titleId && body.title) {
      let imdbId = body.title.imdbId ?? null;
      let tvdbId = body.title.tvdbId ?? null;

      // Fetch external IDs if TMDB is selected but external IDs are missing
      if (body.title.tmdbId && (!imdbId || !tvdbId)) {
        try {
          const external = await fetchExternalIds(body.title.tmdbId);
          imdbId = imdbId || external.imdbId;
          tvdbId = tvdbId || external.tvdbId;
        } catch (err) {
          app.log.warn(
            { err, tmdbId: body.title.tmdbId },
            'Failed to fetch external ids from TMDB',
          );
        }
      }

      const createdTitle = await findOrCreateTitle({
        imdbId,
        tvdbId,
        tmdbId: body.title.tmdbId ?? null,
        nameRu: body.title.nameRu,
        nameEn: body.title.nameEn ?? null,
        year: body.title.year ?? null,
        aliases: [],
        posterUrl: body.title.posterUrl ?? null,
      });
      titleId = createdTitle.id;
    }

    if (!titleId) {
      return reply.code(400).send({ error: 'titleId or title is required' });
    }

    // Cache TMDB season details if TMDB ID is available -- check the cache
    // first (§5.4: "cache aggressively... these change rarely"). Without
    // this, every rule saved against the same show+season re-fetches
    // identical data live from TMDB, e.g. once per torrent for a
    // one-torrent-per-episode show.
    if (body.title?.tmdbId) {
      try {
        const cached = await getProviderSeason(titleId, body.season, 'tmdb');
        if (!cached) {
          const episodes = await fetchSeasonDetails(body.title.tmdbId, body.season);
          if (episodes.length > 0) {
            await upsertProviderSeason({
              title_id: titleId,
              season: body.season,
              source: 'tmdb',
              episode_count: episodes.length,
              episodes: episodes,
            });
          }
        }
      } catch (err) {
        app.log.warn(
          { err, tmdbId: body.title.tmdbId, season: body.season },
          'Failed to fetch/cache season details from TMDB',
        );
      }
    }

    // Editing an existing rule (from the Library view) into a different
    // season: upsertRule's ON CONFLICT target is (torrent_hash, season), so
    // a season change doesn't overwrite the rule being edited -- it would
    // leave the old row (and its now-stale mappings) behind as an orphan.
    // Delete it first in that case. Ownership is checked against
    // torrentHash so a mismatched/stale ruleId can't delete an unrelated
    // rule.
    if (body.ruleId) {
      const existingRule = await getRuleById(body.ruleId);
      if (
        existingRule &&
        existingRule.torrentHash === body.torrentHash &&
        existingRule.season !== body.season
      ) {
        await deleteRule(body.ruleId);
      }
    }

    // Save/upsert rule
    const rule = await upsertRule({
      torrentHash: body.torrentHash,
      titleId: titleId,
      season: body.season,
      numbering: body.numbering,
      sort: body.sort,
      startEpisode: body.startEpisode,
      absoluteOffset: body.absoluteOffset ?? null,
      exceptions: body.exceptions,
      confidence: 1.0, // Manual rules are 100% confident
      source: 'manual',
      proposalReason: null,
      torrentName: torrentName ?? null,
    });

    // Rebuild mappings for this rule. The rule is already committed at this
    // point, so a failure here (a malformed exceptions map, a torrent with
    // no video files, etc.) shouldn't surface as a bare 500 -- report it
    // clearly and let the rule get picked up by the next full ingest's
    // rebuildAllMappings(), which already tolerates per-rule failures.
    try {
      await rebuildMappingsForRule(rule.id);
    } catch (err) {
      app.log.error({ err, ruleId: rule.id }, 'Failed to rebuild mappings for saved rule');
      return reply.code(207).send({
        success: true,
        rule,
        warning: 'Rule saved, but rebuilding its mappings failed -- check server logs.',
      });
    }

    return { success: true, rule };
  });

  // GET /api/library - Grouped titles + seasons + episode coverage grid
  app.get('/library', async (_request, _reply) => {
    const titles = await listTitlesWithSeasons();

    const result = await Promise.all(
      titles.map(async (t) => {
        const seasonsWithCoverage = await Promise.all(
          t.seasons.map(async (s) => {
            // Find all mappings for this show & season
            const mappingsResult = await pool.query(
              `select m.episode, count(m.file_id) as file_count, json_agg(f.raw_path) as files
               from mappings m
               join files f on f.id = m.file_id
               where m.title_id = $1 and m.season = $2
               group by m.episode
               order by m.episode`,
              [t.id, s.seasonNumber],
            );

            const episodes = mappingsResult.rows.map((row) => ({
              episode: parseInt(row.episode, 10),
              count: parseInt(row.file_count, 10),
              files: row.files,
            }));

            // Query all rules for this title + season across all torrents
            const rulesResult = await pool.query(
              'select * from rules where title_id = $1 and season = $2',
              [t.id, s.seasonNumber],
            );

            return {
              seasonNumber: s.seasonNumber,
              mappedEpisodesCount: s.mappedEpisodesCount,
              totalEpisodesCount: s.totalEpisodesCount,
              episodes,
              rules: rulesResult.rows.map((r) => ({
                id: r.id,
                torrentHash: r.torrent_hash,
                numbering: r.numbering,
                source: r.source,
              })),
            };
          }),
        );

        return {
          id: t.id,
          nameRu: t.nameRu,
          nameEn: t.nameEn,
          year: t.year,
          posterUrl: t.posterUrl,
          imdbId: t.imdbId,
          tmdbId: t.tmdbId,
          seasons: seasonsWithCoverage,
        };
      }),
    );

    return result;
  });

  // GET /api/health - Diagnostic dashboard data
  app.get('/health', async (_request, _reply) => {
    // 1. Last ingest run timestamp (max last_seen of active torrents)
    const ingestResult = await pool.query('select max(last_seen) as last_seen from torrents');
    const lastIngestRun = ingestResult.rows[0]?.last_seen ?? null;

    // 2. Count of gone torrents
    const goneCountResult = await pool.query("select count(*) from torrents where status = 'gone'");
    const goneCount = parseInt(goneCountResult.rows[0]?.count ?? '0', 10);

    // 3. List of gone torrents
    const goneTorrentsResult = await pool.query(
      "select hash, raw_name_at_ingest, last_seen from torrents where status = 'gone' order by last_seen desc limit 10",
    );
    const goneTorrents = goneTorrentsResult.rows.map((row) => ({
      hash: row.hash,
      name: row.raw_name_at_ingest,
      lastSeen: row.last_seen,
    }));

    // 4. Dangling mappings (mappings linked to gone torrents)
    const danglingResult = await pool.query(
      `select count(m.file_id) as count
       from mappings m
       join files f on f.id = m.file_id
       join torrents t on t.hash = f.torrent_hash
       where t.status = 'gone'`,
    );
    const danglingMappings = parseInt(danglingResult.rows[0]?.count ?? '0', 10);

    // 5. Files with no mount_path
    const noMountResult = await pool.query(
      'select count(*) from files where is_video = true and mount_path is null',
    );
    const filesNoMountPath = parseInt(noMountResult.rows[0]?.count ?? '0', 10);

    // 6. Recent plays
    const playsResult = await pool.query(
      `select pl.id, pl.at, pl.user_agent, f.raw_path, t.name_ru, m.season, m.episode
       from play_log pl
       left join files f on f.id = pl.file_id
       left join mappings m on m.file_id = f.id
       left join titles t on t.id = m.title_id
       order by pl.at desc
       limit 50`,
    );
    const recentPlays = playsResult.rows.map((row) => ({
      id: parseInt(row.id, 10),
      at: row.at,
      userAgent: row.user_agent,
      rawPath: row.raw_path ?? 'Unknown File',
      titleRu: row.name_ru ?? 'Unknown Show',
      season: row.season,
      episode: row.episode,
    }));

    return {
      lastIngestRun,
      goneCount,
      goneTorrents,
      danglingMappings,
      filesNoMountPath,
      recentPlays,
    };
  });

  // POST /api/ingest/run - Trigger ingest run
  app.post('/ingest/run', async (_request, _reply) => {
    // Run in background so we don't timeout the response
    runIngest().catch((err) => {
      app.log.error({ err }, 'Background Ingest Run failed');
    });

    return { success: true, message: 'Ingest run triggered in background' };
  });
}
