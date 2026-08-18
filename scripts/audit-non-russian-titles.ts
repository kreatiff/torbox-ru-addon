// One-off CLI wrapper (not wired into ingest or any schedule) for titles
// that slipped into the library before src/ingest/pipeline.ts's
// resolveTitleMatch started gating new titles on TMDB's original_language.
// The Health tab in the admin UI offers the same scan/delete as a button
// (GET/DELETE /api/titles/non-russian-audit -- see src/http/routes/api/
// index.ts); both share src/library/nonRussianAudit.ts so they can't drift.
//
// Usage:
//   npx tsx --env-file=.env scripts/audit-non-russian-titles.ts            # report only
//   npx tsx --env-file=.env scripts/audit-non-russian-titles.ts --delete   # report + delete

import { pool } from '../src/db/pool.js';
import { logger } from '../src/logger.js';
import { config } from '../src/config.js';
import {
  findNonRussianTitles,
  deleteTitleWithRules,
  type FlaggedTitle,
} from '../src/library/nonRussianAudit.js';

const DELETE = process.argv.includes('--delete');

function printFlagged(flagged: FlaggedTitle[]): void {
  console.log(`\nFound ${flagged.length} title(s) whose TMDB original_language isn't "ru":\n`);
  for (const f of flagged) {
    const enSuffix = f.title.nameEn ? ` (${f.title.nameEn})` : '';
    console.log(
      `- ${f.title.nameRu}${enSuffix} [tmdbId=${f.title.tmdbId} imdbId=${f.title.imdbId ?? '-'} ` +
        `lang=${f.originalLanguage ?? 'unknown'}] -- ${f.ruleCount} rule(s), ${f.mappingCount} mapping(s)`,
    );
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

  const { checked, total, flagged } = await findNonRussianTitles();
  console.log(
    `Checking ${checked} of ${total} title(s) (the rest have no tmdb_id to check against).`,
  );

  if (flagged.length === 0) {
    console.log('\nNo non-Russian titles found.');
    return;
  }

  printFlagged(flagged);

  if (!DELETE) {
    console.log(
      `\nDry run -- nothing deleted. Re-run with --delete to remove these ${flagged.length} title(s) and their rules/mappings.`,
    );
    return;
  }

  console.log(`\nDeleting ${flagged.length} title(s)...`);
  for (const f of flagged) {
    await deleteTitleWithRules(f.title.id);
    console.log(`  deleted: ${f.title.nameRu}`);
  }
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
