// One-off cleanup tool (not wired into ingest or any schedule) for titles
// that slipped into the library before src/ingest/pipeline.ts's
// resolveTitleMatch started gating new titles on TMDB's original_language.
// Re-checks every title's *live* TMDB original_language (not a cached
// value -- none is stored on titles today) and reports anything that isn't
// "ru". Dry-run by default; pass --delete to actually remove what it finds.
//
// Usage:
//   npx tsx --env-file=.env scripts/audit-non-russian-titles.ts            # report only
//   npx tsx --env-file=.env scripts/audit-non-russian-titles.ts --delete   # report + delete
//
// Titles with no tmdb_id can't be checked this way and are silently
// skipped -- there's nothing to look up.

import { pool } from '../src/db/pool.js';
import { logger } from '../src/logger.js';
import { config } from '../src/config.js';
import {
  listAll as listAllTitles,
  deleteTitle,
  type Title,
} from '../src/db/repositories/titlesRepo.js';
import { deleteRule } from '../src/db/repositories/rulesRepo.js';
import { fetchTvDetails } from '../src/metadata/tmdb.js';

const DELETE = process.argv.includes('--delete');
// Polite spacing between TMDB calls -- this script can run through the
// whole library in one pass, unlike the ingest pipeline's per-torrent
// throttling.
const TMDB_REQUEST_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Flagged {
  title: Title;
  originalLanguage: string | null;
  ruleCount: number;
  mappingCount: number;
}

async function findFlaggedTitles(): Promise<Flagged[]> {
  const titles = await listAllTitles();
  const withTmdbId = titles.filter((t) => t.tmdbId !== null);
  console.log(
    `Checking ${withTmdbId.length} of ${titles.length} title(s) (the rest have no tmdb_id to check against).`,
  );

  const flagged: Flagged[] = [];

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

  return flagged;
}

async function deleteFlagged(flagged: Flagged[]): Promise<void> {
  for (const f of flagged) {
    const rules = await pool.query('select id from rules where title_id = $1', [f.title.id]);
    for (const rule of rules.rows) {
      // Cascades to that rule's mappings -- see rulesRepo.deleteRule's own docstring.
      await deleteRule(rule.id as string);
    }
    await deleteTitle(f.title.id);
    console.log(`  deleted: ${f.title.nameRu}`);
  }
}

async function main(): Promise<void> {
  if (!config.tmdbApiKey) {
    logger.error(
      "TMDB_API_KEY is not configured -- this script needs it to check each title's real original_language.",
    );
    process.exitCode = 1;
    return;
  }

  const flagged = await findFlaggedTitles();

  if (flagged.length === 0) {
    console.log('\nNo non-Russian titles found.');
    return;
  }

  console.log(`\nFound ${flagged.length} title(s) whose TMDB original_language isn't "ru":\n`);
  for (const f of flagged) {
    const enSuffix = f.title.nameEn ? ` (${f.title.nameEn})` : '';
    console.log(
      `- ${f.title.nameRu}${enSuffix} [tmdbId=${f.title.tmdbId} imdbId=${f.title.imdbId ?? '-'} ` +
        `lang=${f.originalLanguage ?? 'unknown'}] -- ${f.ruleCount} rule(s), ${f.mappingCount} mapping(s)`,
    );
  }

  if (!DELETE) {
    console.log(
      `\nDry run -- nothing deleted. Re-run with --delete to remove these ${flagged.length} title(s) and their rules/mappings.`,
    );
    return;
  }

  console.log(`\nDeleting ${flagged.length} title(s)...`);
  await deleteFlagged(flagged);
  console.log('Done.');
}

try {
  await main();
} catch (err) {
  logger.error({ err }, 'audit-non-russian-titles failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
