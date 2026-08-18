// Shared logic behind the Russian-only auto-match cleanup: finding titles
// whose live TMDB original_language isn't Russian, and removing one.
// Used by both scripts/audit-non-russian-titles.ts (CLI) and the admin
// API's /api/titles/non-russian-audit routes (Health tab UI) -- kept here,
// not in either caller, so the two never drift.

import { pool } from '../db/pool.js';
import {
  listAll as listAllTitles,
  deleteTitle,
  type Title,
} from '../db/repositories/titlesRepo.js';
import { deleteRule } from '../db/repositories/rulesRepo.js';
import { fetchTvDetails } from '../metadata/tmdb.js';
import { logger } from '../logger.js';

// Polite spacing between TMDB calls -- a full scan can run through the
// whole library in one pass, unlike the ingest pipeline's per-torrent
// throttling.
const TMDB_REQUEST_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FlaggedTitle {
  title: Title;
  originalLanguage: string | null;
  ruleCount: number;
  mappingCount: number;
}

export interface NonRussianAuditResult {
  checked: number;
  total: number;
  flagged: FlaggedTitle[];
}

/**
 * Re-checks every title with a tmdb_id against TMDB's *live*
 * original_language (nothing is cached on titles today) and returns
 * everything that isn't "ru". Titles with no tmdb_id can't be checked this
 * way and are silently excluded from `checked` -- there's nothing to look
 * up. Read-only; deletes nothing.
 */
export async function findNonRussianTitles(): Promise<NonRussianAuditResult> {
  const titles = await listAllTitles();
  const withTmdbId = titles.filter((t) => t.tmdbId !== null);

  const flagged: FlaggedTitle[] = [];
  for (const title of withTmdbId) {
    let details;
    try {
      details = await fetchTvDetails(title.tmdbId as number);
    } catch (err) {
      logger.warn(
        { err, tmdbId: title.tmdbId, title: title.nameRu },
        'Failed to fetch TMDB details for this title -- skipping it this run',
      );
      await sleep(TMDB_REQUEST_DELAY_MS);
      continue;
    }
    await sleep(TMDB_REQUEST_DELAY_MS);

    if (details?.originalLanguage === 'ru') {
      continue;
    }

    const rules = await pool.query('select id from rules where title_id = $1', [title.id]);
    const mappingCount = await pool.query('select count(*) from mappings where title_id = $1', [
      title.id,
    ]);
    flagged.push({
      title,
      originalLanguage: details?.originalLanguage ?? null,
      ruleCount: rules.rows.length,
      mappingCount: Number(mappingCount.rows[0].count),
    });
  }

  return { checked: withTmdbId.length, total: titles.length, flagged };
}

/**
 * Deletes a title and every rule that points at it (rules.title_id has no
 * `on delete cascade`, and rulesRepo.deleteRule itself cascades to that
 * rule's mappings -- see its own docstring) -- so this is the full
 * "remove this title from the library" cascade, not just the row.
 */
export async function deleteTitleWithRules(titleId: string): Promise<void> {
  const rules = await pool.query('select id from rules where title_id = $1', [titleId]);
  for (const rule of rules.rows) {
    await deleteRule(rule.id as string);
  }
  await deleteTitle(titleId);
}
