# CLAUDE.md

A self-hosted Stremio addon that makes a TorBox library of Russian TV
watchable: it ingests torrents from a TorBox account, works out which show
and episode each video file is, and serves the result over the Stremio addon
protocol. A Google-authenticated admin UI at `/admin` handles the cases the
automation can't.

Node 22, TypeScript (ESM, `.js` import specifiers), Fastify, raw `pg` (no
ORM), React + Vite for the UI, Postgres 16.

## Commands

| | |
| --- | --- |
| `npm test` | Vitest. **Skips 154 of 336 tests unless `TEST_DATABASE_URL` is set** — see below. |
| `npm run typecheck` / `lint` / `format` / `format:check` | All four run in CI and gate the Docker publish. |
| `npm run migrate:up` | Applies `migrations/`. Needs a `.env`; CI invokes `src/db/migrate.ts` directly instead. |
| `npm run ingest` | One-shot ingest run, same code path as the scheduler. |
| `cd ui && npm run build` | `tsc -b && vite build` — this is the UI's typecheck as well as its bundle. |

**The integration tests need a real Postgres and silently no-op without
one.** Every `describe.skipIf(!hasTestDb)` block (all of `test/db`, most of
`test/http`) is invisible unless you export `TEST_DATABASE_URL` pointing at
a migrated Postgres 16. A green `npm test` with no database means roughly
half the suite did not run. Locally:

```bash
pg_ctlcluster 16 main start && su postgres -c "createdb torboxru_test"
export TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/torboxru_test
DATABASE_URL=$TEST_DATABASE_URL TORBOX_API_KEY=x ADDON_TOKEN=x \
  PUBLIC_BASE=http://localhost:3000 GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x \
  SESSION_SECRET=x-at-least-32-bytes-long-for-real ALLOWED_EMAILS=x@example.com \
  npx tsx -e "import('./src/db/migrate.ts').then(m => m.migrateUp())"
npm test
```

## How a file becomes an episode

`src/ingest/pipeline.ts` (`runIngest`) is the spine, run every
`INGEST_INTERVAL_MINUTES` (default 15) and on the TorBox webhook:

1. TorBox mylist → `torrents` + `files`.
2. RuTracker Atom feed → `feed_entries` (observational; the Download action
   in the Feed tab is what actually fetches anything).
3. Torrents with no rule → LLM extraction (`src/llm/opencodeZen.ts`) →
   `proposeRule` → either committed or parked in the Queue for a human.
4. Queued provider-mismatch rules re-checked and promoted if TMDB caught up.
5. `rebuildAllMappings()` reconciles every rule's `mappings`.

`mappings` is **materialised from `rules`, never edited row by row** — a rule
plus its torrent's files is the only source of truth, and `expandRule` is the
pure function that turns one into the other. The addon routes
(`src/http/routes/addon/`) only read `mappings`.

## Invariants worth knowing before changing things

- **`rules.queue_reason` is non-null if and only if the rule is queued.**
  Callers select on it alone. `Rule.queueReason` is deliberately non-optional
  in TypeScript so that any new path taking a rule out of the Queue is a
  compile error until it clears the column.
- **`rebuildAllMappings()` is a reconciliation loop, not redundant work.**
  It writes only when the expansion differs from what's stored, but it must
  keep *checking* everything: `downloadFeedEntry.ts` pre-creates rules before
  their torrent has any files, and this sweep is what turns them into
  mappings once the files land. Don't make it event-driven.
- **`provider_seasons` must keep self-healing.** It caches TMDB season data,
  but a season still airing gains episodes; `getOrRefreshProviderSeason`
  re-fetches when the cache doesn't cover the episode being checked. Caching
  it once and trusting it forever is a bug that silently parks new episodes
  in the Queue.
- **The addon serves its own `torboxru:<uuid>` ids on purpose.** Stremio uses
  whichever installed addon answers `meta` first, and Cinemeta always wins
  for `tt` ids, so sharing its id scheme would mean this addon's
  Kinopoisk-backed metadata never being seen.
- **`src/resolve/expandRule.ts` and `src/resolve/types.ts` must stay
  dependency-free.** `ui/` imports them directly across the workspace
  boundary for its live preview; pulling `config.ts`/`logger.ts` (and so zod
  and pino) into either one breaks the UI build.

## Layout

```
src/
  ingest/      pipeline (runIngest), materialize (rules -> mappings), downloadFeedEntry
  resolve/     expandRule + numbering modes + proposeRule   <- pure, no I/O, no DB
  extract/     regex cascade (manual Labeller option; auto-proposals use the LLM)
  metadata/    tmdb, kinopoisk, providerSeasonCache
  db/          pool, migrate, repositories/ (raw SQL, zod-validated at the read boundary)
  http/routes/ addon/ (Stremio), api/ (admin), webhooks/, admin/ (static UI)
ui/src/
  App.tsx      shell: queries, mutations, tab state, toasts, nav
  views/       one file per tab, plus TitleFormModal
  types.ts     admin API shapes (mirrors src/http/routes/api/index.ts)
```

## Conventions

- **Comments explain why, not what.** This codebase leans hard on that: most
  non-obvious lines carry the reasoning, the alternative that was rejected,
  or the real-world failure that motivated them. Match it; don't strip it.
- **`docs/decisions.md` is the decision log.** Anything chosen that the spec
  didn't dictate goes there with its reasoning. Read it before relitigating
  a design decision — it probably explains itself.
- Migrations are timestamped, additive and reversible; write the `down`.
- Markdown is excluded from Prettier (`.prettierignore` says why), so
  `format:check` covers code only.
- `.git-blame-ignore-revs` lists formatting-only commits.

## CI

`.github/workflows/ci.yml` runs typecheck, lint, format:check and the full
suite against a `postgres:16` service, plus the UI lint and build.
`docker-publish.yml` calls it via `workflow_call` and `needs` it, so a push
to `dev` cannot publish an image unless all of that passed on that commit.
