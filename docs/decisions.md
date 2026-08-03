# Decisions log

Every decision made so far that wasn't spelled out unambiguously in
[`torbox-ru-addon-spec.md`](../torbox-ru-addon-spec.md), organized by area. Each entry names the
spec section it responds to (where one exists) and where to find it in code. Items still
awaiting the repo owner's explicit sign-off are marked **PENDING**; everything else has already
shipped as described. The original proposals for the Tier-1/2/3 items are in
[`torbox-ru-addon-plan.md`](../torbox-ru-addon-plan.md) §3 — this file additionally tracks what
actually happened once implementation started, including a few decisions the plan didn't
anticipate.

## Where this disagreed with the spec

| Decision | Why | Spec ref | Status |
|---|---|---|---|
| Manifest declares `"types": ["series"]`, not `["series", "movie"]` | Movies are an explicit v1 non-goal (§8) and the pipeline is series-first throughout; advertising a type that always returns empty is the kind of silent gap the spec elsewhere insists on surfacing. Not marked LOCKED, unlike its neighbors. | §5.5, §8 | **PENDING** — not built yet (Milestone 3) |
| No WebDAV FUSE mount inside the app container | `TORBOX_MOUNT_PATH` is optional and off the streaming critical path entirely — playback goes through `requestdl` by `torbox_file_id`, never a filesystem path. `docker-compose.yml` can bind-mount a host-level WebDAV mount read-only instead if one exists outside Docker. | §5.2, §9 | Not built yet; `files.mount_path` column exists, nothing populates it |

## Tooling & infrastructure (spec explicitly left these to the implementer)

| Decision | Why | File(s) |
|---|---|---|
| **node-pg-migrate**, not Drizzle, for migrations | §4's DDL is already final-ish with load-bearing comments; an ORM means maintaining a second schema representation that has to stay bit-for-bit synced with SQL that already says exactly what it means. | `migrations/` |
| Migration bodies are near-verbatim `pgm.sql(...)` wrapping §4's DDL, not the fluent builder API | Same translation-risk reasoning, one level down — re-deriving already-correct DDL through a builder API risks a subtle mismatch. | `migrations/1785725438965_init-schema.ts` |
| Hand-written repositories over plain `pg`, zod-validated at every read boundary | Gets the type-safety win of an ORM without the schema-sync risk; the spec already mandates zod for the TorBox client (§5.1), so this extends the same discipline to reads from Postgres. | `src/db/repositories/`, `src/db/schema.types.ts` |
| **Vitest**, split into a fast path (no external deps) and integration tests gated on `TEST_DATABASE_URL` | TS/ESM-native, good fixture-table DX. Originally planned around `testcontainers-node`; see below for why that changed. | `vitest.config.ts`, `test/` |
| ~~testcontainers-node~~ → plain `TEST_DATABASE_URL` env var | **Deviation from the original plan.** The build sandbox's egress policy blocks Docker Hub entirely, so testcontainers (which needs to pull a Postgres image) can't run there. Integration tests instead point at any reachable Postgres 16 via `TEST_DATABASE_URL` and skip themselves (`describe.skipIf(!hasTestDb)`) when it's unset. Revisit testcontainers if tests ever need to run somewhere with no pre-existing Postgres available. | `test/db/testDb.ts`, `test/setup.ts` |
| `vitest.config.ts` sets `fileParallelism: false` | **Not anticipated in the plan.** Discovered empirically: multiple test files sharing one real Postgres and each truncating tables in `beforeEach` will race each other under Vitest's default cross-file parallelism, causing spurious FK-violation and count-mismatch failures. Serializing test files fixed it; the suite is small enough that this costs nothing. | `vitest.config.ts` |
| `pg`'s bigint columns (`torbox_id`, `size`, bigserial ids) parsed as JS `number`, not string/BigInt | Every bigint column here holds a "normal sized" number (a row id, a byte count) nowhere near `Number.MAX_SAFE_INTEGER`; parsing as `pg`'s default string would force BigInt/string-handling through every size comparison and sort for no real benefit. | `src/db/typeParsers.ts` |
| `gen_random_uuid()` defaults added to the two uuid primary keys (`titles.id`, `rules.id`) | §4's DDL doesn't say how ids get generated. Postgres 16 has `gen_random_uuid()` built in since PG13 — simplest option, and repository code never has to generate ids itself. | `migrations/1785725438965_init-schema.ts` |
| CHECK constraints added on `torrents.status`, `rules.numbering`/`sort`/`source` | The TS union types for these already exist verbatim in the spec (§3.7, and the `torrents.status` comment) — the constraints enforce an invariant the spec already documents, not a new one. | same migration |
| Milestone 1's "app" is a one-shot batch job (migrate → ingest once → exit), not a long-running server | The build order (§6) doesn't introduce `src/http` until Milestone 3, and ingest *scheduling* is explicitly Milestone 6 — a persistent process with nothing to schedule and no server to run would be either idle or misleading about what's implemented. `docker-compose.yml`'s `app` service currently has `restart: "no"` for the same reason. | `src/index.ts`, `docker-compose.yml` |
| Postgres has no `ports:` mapping in `docker-compose.yml` | Only `app` needs to reach it, over the compose-internal network; nothing about Postgres should be reachable from the Cloudflare Tunnel once that's wired up (Milestone 3+). | `docker-compose.yml` |

## Schema additions beyond §4's literal DDL

| Decision | Why | Spec ref | Status |
|---|---|---|---|
| Additive `provider_seasons` table (title_id, season, source, episode_count, episodes jsonb, fetched_at) + `titles.poster_url` | §5.3's confidence scoring, §5.6's validation banners, §3.5.3's air-date extractor stage, and the show picker's "per-season episode counts" all need per-season provider data that §4 has nowhere to put, even though §5.4 explicitly says to cache provider lookups in Postgres. Keyed by `(title, season, source)` so TMDB and TVDB each keep an independent view. | §4, §5.3, §5.4, §5.6 | Implemented (`migrations/1785725439402_provider-cache.ts`); **PENDING** sign-off since §4 was called "close to final" |
| Nullable-unique constraints on `titles.tvdb_id`/`titles.tmdb_id` (matching the existing `imdb_id` constraint) | Only `imdb_id` was unique in §4, and it's nullable — meaning the shows *most* likely to lack one (the exact case the spec calls out) had zero duplicate protection. `titlesRepo.findOrCreate` (Milestone 4) still needs to actually use this. | §4, §9 | Implemented; **PENDING** sign-off |

## `src/resolve/expandRule` (Milestone 2)

| Decision | Why | Spec ref | Status |
|---|---|---|---|
| `sequential` = sort, then `episode = startEpisode + index` | The deliberate human-override mode: don't try to interpret filenames, just count them in sorted order. | §3.7 (type shape only, not semantics) | Implemented |
| `continuous` = sort, then `episode = startEpisode + index − absoluteOffset`, treating `startEpisode` as an absolute number | **Revised from the original plan.** The plan assumed this mode needed the (not-yet-built) extractor cascade to find each file's absolute episode number; implementing it revealed it's actually pure position/offset arithmetic, assuming a contiguous run of episodes within the torrent — true of every example in the spec. Shipped in Milestone 2 instead of waiting for Milestone 5. A per-file `absolute_hint` from the real cascade would only matter for a non-contiguous torrent, which no current example requires. | §3.5, §3.7 | Implemented |
| `manual` = only files with an explicit `exceptions` entry get a mapping; everything else is dropped, no fallback | Distinguishes it from the other three modes, which all have *some* positional/parsed fallback for non-excepted files. | §3.7 | Implemented |
| `parsed` throws a clear "not implemented, needs the extractor cascade" error | Real per-file text parsing (SxxExx / word+number / air-date / positional fallback) is Milestone 5 scope (§6: "do not skip ahead"). Fails loudly rather than guessing. | §3.5, §6 | Stubbed, throws by design |
| `exceptions` (including `'ignore'`) resolved once, before mode dispatch, and excluded from the position count | Removing a trailer must not shift every episode number after it — the position count only ever sees files that don't already have an explicit answer. | §5.6 ("ignore this file" toggle) | Implemented |
| Non-video files never produce a mapping, filtered inside `expandRule` itself | A domain rule intrinsic to what "expand a rule into episode mappings" means; keeps every caller from having to remember to pre-filter. | — | Implemented |
| `expandRule` sorts by `rawPath`, not `mountPath`, even when the latter is set | Mount discovery isn't built yet and rarely populated; `rawPath` is always available. Worth reconsidering once mount discovery (an optional pass, still unbuilt) is common. | §5.2, §9 | Implemented, flagged for revisit |
| `rulesRepo.getRuleById`/`listRules` throw if `torrent_hash`/`title_id` is null | §4's DDL has no `NOT NULL` on these FK columns (transcribed verbatim), but a rule with either unset can't be materialised into anything meaningful. Enforced once, at the read boundary, rather than pushing `| null` through `Rule` and every numbering function that doesn't otherwise need it. | §4 | Implemented |
| `rebuildAllMappings()` wired into the end of every ingest run | §5.2 names "rebuild mappings" as a pipeline step. "Propose rules" (the step before it) doesn't exist yet, so this currently just reprocesses whatever rules already exist — hand-inserted ones for now, UI-authored ones from Milestone 4. One rule failing (most likely `numbering: 'parsed'`) is logged and skipped rather than aborting the run. | §5.2 | Implemented |

## `src/torbox` client (Milestone 1)

| Decision | Why | Spec ref | Status |
|---|---|---|---|
| `envelope.ts` checks `success` before ever touching `data`, on every response | The spec's own warning: `{"success":false,...,"data":null}` looks identical to an empty library if `success` isn't checked first. Logs the raw body on any failure — both `success:false` and a `success:true` body that fails its schema. | §5.1 | Implemented |
| Response field names in `schemas.ts` are a best-effort reconstruction | This build sandbox has no network path to `api.torbox.app` (confirmed via the proxy's own status endpoint — a 403 policy denial, not a timeout), so nothing here has been checked against a live response. Every field is optional/nullable where uncertain so a mismatch degrades to a logged gap instead of a crash. | §5.1 | **PENDING real-world verification** — see `docs/history.md` |
| `files` on a mylist torrent is `undefined` when absent, never defaulted to `[]` | Its *absence*, not emptiness, is the signal to fall back to a per-torrent `?id=` fetch. | §5.1 | Implemented |
| Per-torrent fallback fetches are rate-limited (serial + fixed delay via `TORBOX_REQUEST_DELAY_MS`, default 250ms); torrents with inline `files` are not throttled at all | TorBox doesn't publish a rate limit, so a conservative default was chosen rather than invented confidence; only calls that actually hit the API need throttling. | §5.1 ("Rate-limit yourself") | Implemented, default tunable |
| `getPlaybackUrl` fetches `requestdl` with `redirect: 'manual'` and reads the `Location` header itself | The whole point is handing that URL to `/play/:fileId`'s own redirect — the app must never follow through to the CDN itself, and must never hand the client a URL containing `TORBOX_API_KEY`. Written now (Milestone 1's "TorBox client" scope) even though nothing calls it until Milestone 3. | §5.5 (LOCKED: never return a URL containing the key) | Implemented, unused until Milestone 3 |
| `refreshWebdav()` is best-effort: failures are logged and swallowed, never abort ingest | The spec doesn't say how the WebDAV host authenticates (it may not be the same bearer token as the REST API), and force-refresh is an optimisation — the view auto-refreshes every 15 minutes regardless. | §5.1, §9 | Implemented; auth mechanism unverified (same network limitation as above) |
| `markAbsentGone` refuses to do anything when given an empty present-list | An empty `mylist` response is exactly as ambiguous as `{"success":false,...,"data":null}` — could be a real empty library or a transient API problem. Treating it as "mark everything gone" would be the single worst failure mode the spec names (§9: a wrong mapping that looks like it worked), just applied to every torrent instead of one. | §9 | Implemented, covered by a dedicated test |
| `is_video` computed from a fixed file-extension allowlist (mp4, mkv, ts, avi, webm, mov, wmv, m4v, flv, mpg, mpeg) | Not specified by the spec; a reasonable default, easy to extend if a real library turns up something missing. | — | Implemented |
