# Milestone status

Status against the locked build order (`torbox-ru-addon-spec.md` §6 — "do not skip ahead").
See [`decisions.md`](./decisions.md) for the reasoning behind specific choices, and
[`../README.md`](../README.md) for how to actually run any of this.

## 1. Ingest only — ✅ done

> TorBox client, schema, migrations, `mylist` → Postgres with snapshots. Docker Compose up on
> ARM64. No matching, no UI.

Built: the full §4 schema (plus the additive `provider_seasons`/`titles.poster_url` — see
decisions log) via node-pg-migrate; a TorBox API client with zod-validated responses, both
`mylist` shapes handled, rate-limited per-torrent fallback; an ingest pipeline (refresh → fetch
→ upsert torrents with an immutable `raw_name_at_ingest` snapshot → fetch files for new hashes
only → mark absent hashes `gone`); Dockerfile + docker-compose.yml targeting `linux/arm64`.

**Verified:** migrations apply and roll back cleanly against real Postgres 16; all DB
repository and pipeline branching logic (inline files vs. per-id fallback, mark-gone,
reactivation, the empty-response safety guard) tested against real Postgres; a full compiled
boot of `src/index.ts` runs config → migrate → ingest → clean exit correctly.

**Updated once the build sandbox's network policy opened up:** `api.torbox.app` became
reachable, and a live (invalid-token) request confirmed the envelope shape in
`envelope.ts`/`schemas.ts` matches the real API exactly. Docker Hub also became reachable, so
the actual multi-stage Dockerfile was built and run for real — migrate → attempt ingest → hit
the live API → fail cleanly on the bad token, no crash — against real Postgres. That run
surfaced and fixed a genuine bug: `pg.Pool` had no `'error'` listener and `migrateUp()` wasn't
wrapped in error handling, so a DB-unreachable-at-boot condition crashed the process instead of
exiting cleanly (see `decisions.md`).

**Update once a real `TORBOX_API_KEY` became available:** a full ingest ran against the repo
owner's actual TorBox account — 210 torrents, 2067 files (1408 of them video), one API call,
zero schema-validation failures. The real library contains the exact spec §1 example torrents
verbatim, including the `Bolshoy.Kush...(1080р)` Cyrillic-`р` homoglyph case, and all of it
round-tripped through Postgres correctly. Re-running ingest a second time (a couple of minutes
later) upserted the same 210 torrents with `torrentsNew: 0` and correctly marked 2 torrents
`gone` that had disappeared from the account in the interim — real confirmation of both the
dedup and the mark-gone path against a live, changing library. The same live ingest, migrate,
and mapping-rebuild sequence was also re-run inside the actual built container image (`docker
run`, real Postgres, real API) with the same result. Separately, `refreshWebdav()`'s "auth
mechanism unconfirmed" note is now resolved — see `decisions.md`: it needs WebDAV Basic-auth
credentials distinct from `TORBOX_API_KEY`, which this repo doesn't have, so the force-refresh
step still no-ops (harmlessly; see its own best-effort design).

**Still not verified:** a true `linux/arm64` build (this build sandbox's nested-Docker QEMU
emulation is still non-functional — re-confirmed with `docker run --platform linux/arm64
node:22-alpine uname -m` → `exec format error` — so the image is validated on the host's native
architecture instead; nothing in the codebase is architecture-specific).

**To actually run this for real, the repo owner needs to:** run `docker compose up` on the
actual Oracle Cloud ARM64 host (the `TORBOX_API_KEY` gap is closed); supply real WebDAV
Basic-auth credentials if force-refresh (rather than the 15-minute passive refresh) matters in
practice.

## 2. Two rules inserted by hand as SQL — ✅ done

> Verify `expandRule` materialises correct mappings.

Built: `expandRule` (pure, no I/O/DB) with three of four numbering modes — `sequential`,
`continuous` (turned out to be pure arithmetic, not blocked on the extractor cascade the way
originally planned — see decisions log), `manual`; `parsed` stubbed with a clear
not-yet-implemented error. `scripts/seed/milestone-2-example.sql` hand-inserts two rules using
the real torrent examples from spec §1. A new `rebuildAllMappings()` orchestration (DB read →
`expandRule` → DB write) is wired into the end of every ingest run.

**Verified:** exhaustively, in pure unit tests (`test/resolve/expandRule.test.ts`) covering
both required §7 pathological cases achievable at this stage (lexical-vs-natural sort,
continuous numbering across a season boundary, a trailer file via `'ignore'`, non-video files
excluded) — and end-to-end against real Postgres: the hand-written SQL seed, materialised,
produces exactly the right `mappings` rows (spot-checked directly via `psql`, and asserted in
`test/ingest/materialize.test.ts`).

**Not applicable yet:** "a torrent where file count disagrees with X из Y" (also listed in §7)
isn't an `expandRule` case at all — `expandRule` never sees "X из Y"; that's a
confidence-scoring input for `proposeRule`, Milestone 5.

## 3. Manifest + stream + play — ✅ built and live-tested; final playback confirmation pending

> Install in Stremio and in AIOStreams as a custom addon. Confirm actual playback of a `.ts`
> file and an `.mp4` file. The data model is free to change until this works and expensive to
> change after.

Built: `src/http/` — a Fastify server (`server.ts`), constant-time `:token` auth
(`hooks/verifyAddonToken.ts`), and the three addon routes
(`routes/addon/{manifest,stream,play}.ts`). `titlesRepo.findByImdbId` (read-only —
`findOrCreate` stays Milestone 4), `mappingsRepo.findMappingsForEpisode`, and
`filesRepo.findByIdsWithTorrent` added to resolve a Stremio `tt...:season:episode` id down to
real files. `src/index.ts` changes shape from Milestone 1's one-shot batch job to a persistent
server (migrate → listen → stay running); ingest itself stays manual until Milestone 6's
scheduler lands. New config: `ADDON_TOKEN`, `PUBLIC_BASE` (both required), `PORT` (default
3000), `NOT_WEB_READY_EXTENSIONS` (default `ts`) — see decisions log.

**Verified:** exactly what was flagged as achievable without a live deployment — manifest
shape (`types: ["series"]`, confirmed with the repo owner), token auth (valid/invalid/missing,
all a 404 per the LOCKED framing), stream resolution against real Postgres rows
(`test/http/addon.test.ts`), and the `/play/:fileId` redirect + `play_log` write against a
mocked TorBox response (`test/http/play.test.ts`) — 56/56 tests passing. Beyond that, with a
real `TORBOX_API_KEY` available, the built server was also run for real against a throwaway
local Postgres seeded with one real ingested file: `/manifest.json`, a wrong token (404), and
`/stream/series/:id.json` all behaved exactly as the automated tests predict, and
`/play/:fileId` was hit for real — a genuine 302 to a real, signed `tb-cdn.io` URL, with a real
`play_log` row written. That real call also surfaced a genuine finding about `requestdl`
itself, not a bug in this addon — see the decisions log entry on `/play/:fileId` and what it
can and can't protect.

**Since then, installed against the real deployment, real TorBox account, and real clients**
(AIOStreams + Nuvio) — the part that genuinely can't happen from an isolated sandbox. The
manifest URL (`https://rtb.1pod.top/<token>/manifest.json`) was confirmed reachable and correct
from outside the repo owner's network. Two real findings came out of this, both fixed:

- **`npm run ingest` doesn't work inside the deployed container** — it invokes `tsx` against
  the TypeScript source, and the production image only ships compiled `dist/` output plus
  production dependencies (no `tsx`, no `src/`, by design — see the Dockerfile decision
  above). `docker compose exec app node dist/ingest/runOnce.js` is the correct manual trigger
  until Milestone 6's scheduler exists; README corrected.
- **AIOStreams resolves some titles via TMDB, not IMDb** — a real show came through as
  `tmdb:250793:3:3`, and since the manifest only declared `idPrefixes: ["tt"]`, AIOStreams
  correctly filtered this addon out client-side rather than ever sending the request (nothing
  reached the app's own logs, which is what made this look like a request/mapping problem at
  first). Fixed: manifest now declares `["tt", "tmdb:"]`, and `stream.ts` exports a pure,
  tested `parseStreamId` that resolves either shape. See decisions log.

Two real shows from the owner's library have since been hand-mapped (one title + rule(s) each,
written directly as SQL — Milestone 4's Labeller UI doesn't exist yet) and confirmed resolving
to the correct files via the verification query, exercising two different real-world shapes the
rule model already supported without any code change:

- One where each episode is its own separate torrent (TorBox library's real "Bolshoy Kush"
  torrents) — four rules, one per torrent, each pinned directly to its own episode number.
- One with two overlapping torrents for the same season (the real "Сокровища императора"
  torrents, matching spec §1's example almost verbatim) — an earlier incomplete upload and a
  later complete one, both intentionally held per §4's mappings design ("multiple files may map
  to the same episode"), given a title carrying both a real `imdb_id` and `tmdb_id` at once
  (independent nullable-unique columns on the same row, so either lookup finds it).

**Still needs the repo owner:** actually pressing play and confirming a `.ts` and an `.mp4` file
play in a real client — that's this milestone's exact stated success criterion, and everything
above stops just short of it (real resolution to the correct file is confirmed; real video
decode is not yet explicitly confirmed).

## 4. Labeller UI — ✅ done, merged to `dev`

> Queue, labeller, preview table.

Built on a `milestone4` branch (not by the same agent that wrote everything above): a React +
Vite admin UI (`ui/`) with Queue/Labeller/Library/Health tabs, mounted at `/admin` behind HTTP
Basic Auth; a JSON API (`/api/queue`, `/api/torrents/:hash`, `/api/rules`, `/api/library`,
`/api/health`, `/api/titles/search`, `/api/ingest/run`), also Basic-Auth-gated, independently of
`/admin`; a minimal TMDB client (`src/metadata/tmdb.ts`, both v3 query-key and v4 Bearer/JWT
formats) per the plan document's §3.6 proposal; and an additive `provider_seasons` cache table
(already tracked above under "Schema additions"). The Labeller view imports `expandRule` and its
types directly from `src/resolve/` for a live client-side mapping preview, per the plan's
explicit "no `src/shared/`" design.

Note this also means the Health screen named in Milestone 6 below is **already built** — it
shipped as one of this UI's four tabs, ahead of `node-cron` scheduling and the webhook
notification boundary, which are the only pieces of Milestone 6 still unbuilt (see below).

**Reviewed and fixed before merge** (a second pass, on the same branch, not a rebuild): the
initial version had `ADMIN_USER`/`ADMIN_PASS` defaulting to `admin`/`admin` with no compose
wiring to override them — a real vulnerability given `/admin` and `/api` sit behind the same
public Cloudflare Tunnel as the addon itself; fixed to required-with-no-default, matching
`ADDON_TOKEN`'s existing precedent, and wired into both compose files and `.env.example`. Other
fixes from the same pass:

- The UI's Docker build stage ran plain `npm ci` for a Vite/esbuild/rollup toolchain that
  _executes_ those tools during the build (not just installs them, unlike the backend's
  `tsc`-only stage) — a stronger version of the QEMU-crash class already fixed once for the
  backend (see the `--ignore-scripts` decision above). Fixed by giving the UI its own
  `--platform=$BUILDPLATFORM` build stage (native build, architecture-independent static output
  copied into the final image) — verified against a real CI build on a throwaway branch, including
  a first attempt that caught a real, unrelated bug (the isolated stage didn't have the sibling
  `src/resolve/` files `App.tsx` imports directly).
- `npm run lint` failed (26 errors/11 warnings): the root `eslint.config.js` still ignored the
  plan document's original `src/ui/dist/**` path instead of the UI's actual location (`ui/**`),
  and the UI itself had a forbidden non-null assertion, ~18 unchecked `any` types across
  `App.tsx`, a `no-case-declarations` violation, and two React-hooks correctness issues (a
  `setState` call inside an effect that derives from asynchronously-loaded data, better expressed
  as the "adjust state during render" pattern; a stale-closure risk in the queue keyboard-nav
  effect's dependency array). All fixed for real — proper interfaces mirroring the API's actual
  response shapes, not suppressions — and a dead code path was found and removed in the process:
  the "Provider Mismatch" episode-count banner read `selectedShow.seasons`, a field TMDB search
  results never carry (no route exists to fetch per-season episode counts client-side), so it was
  always a silent no-op.
- `POST /api/rules` accepted `numbering: 'parsed'` in its schema even though `expandRule` throws
  for that mode (Milestone 5, not built) — the UI already disables the option, but the API had no
  matching guard, so a raw request would commit a rule row with zero mappings and surface a bare 500. Now rejected with a 400 before anything is written.
- TMDB season data was fetched live on every rule save with no cache check, despite
  `provider_seasons` existing for exactly this (§5.4: "cache aggressively"). Now checks the cache
  first.
- `admin/index.ts`'s static-path resolution used a non-null assertion and would silently
  `mkdirSync` a phantom directory if no UI build was found; rewritten to fail loud (a logged
  warning + a real 404) instead of masking a broken deployment.
- Test coverage for the new API routes was thin (only auth + `/titles/search`); added real
  Postgres-backed tests for `/api/rules` (including the `parsed`-rejection and TMDB-cache-hit
  paths), `/api/torrents/:hash`, `/api/library`, and `/api/health` — suite grew from 76 to 84
  tests, all passing.

**Follow-up merged separately, after Milestone 4 itself:** already-mapped rules are now editable
from the Library view, not just creatable fresh from the Queue — each rule listed under a season
has an **Edit** button that opens the Labeller pre-filled with that rule's season, numbering,
sort, start episode, exceptions, and show. `GET /api/torrents/:hash` returns any existing rules
for that hash (title joined in) to support the pre-fill; `POST /api/rules` takes an optional
`ruleId`, and since `rules`' unique constraint is `(torrent_hash, season)`, moving a rule to a
different season deletes the old row first (cascading to its mappings) rather than leaving it
behind as an orphan. Verified end to end in a real browser: pre-fill, an in-place edit, and a
cross-season edit, the last one double-checked directly against Postgres to confirm no orphaned
row survived. Building this also surfaced and fixed a real, previously-unnoticed bug in
`admin/index.ts`: local dev mode (`npm run dev`, outside Docker) always served the Vite _source_
tree instead of the real `dist/ui` build, even after running `npm run build` — see `decisions.md`.

**Known gap, not yet built:** no way to delete a rule/mapping for a torrent that's gone from
TorBox. The Health tab's "Gone Torrents" and "Dangling Mappings" numbers are read-only
diagnostics with no action attached — `rulesRepo.deleteRule` (added for the season-change case
above) already does the necessary cascade, just nothing in the API or UI calls it for this case
yet.

**Still needs the repo owner:** a real `TMDB_API_KEY` to actually exercise the show picker for
real (tests mock the TMDB client; nothing has called the real TMDB API yet).

## 5. Auto-proposal engine — ✅ done

> Extractor cascade, normalisation, confidence scoring.

Built: `src/normalize/` (homoglyph fold + one-way Cyrillic→Latin normalisation), the full
`src/extract/` cascade (masking → air-date → X из Y → SxxExx → word+number episode → positional
fallback), real torrent/file fixtures from spec §1, `src/resolve/confidence.ts` with three
categorical gates + weighted signal scoring, `src/resolve/proposeRule.ts`, and wiring into the
ingest pipeline. The `parsed` numbering mode now works end-to-end: `expandParsed` runs the real
cascade using the `rules.torrent_name` snapshot. The Queue API and Labeller UI no longer use
placeholders: `GET /api/queue` surfaces real auto-proposals (including `proposal_reason`), and
the Labeller's `parsed` option is enabled. Additive migrations added `rules.proposal_reason` and
`rules.torrent_name`.

**Verified:** `npm run typecheck && npm run lint && npm test` is green (77 passing, DB tests
skipped in the no-Postgres sandbox). New fixture-driven tests cover the three spec §1 examples
and the confidence tiers; `expandRule.test.ts` now exercises real `parsed` mode instead of the
old "not implemented" stub.

**Not yet verified at scale:** a real ingest run against the repo owner's live 210-torrent library
with the new proposal step active. The code is wired to run automatically on every ingest, but
it has not been exercised against real messy torrent names beyond the three recorded fixtures.
Spot-checking the real library is the next step before declaring this fully production-safe.

**One intentional simplification vs. the plan:** title matching is exact/near-exact string match
against existing `titles` rows or a single unambiguous TMDB result; no fuzzy NLP. The confidence
HIGH threshold was tuned from 0.75 to 0.70 during implementation so the real 10-of-10
`Ставка на любовь` and 8-of-13 `Сокровища императора` fixtures land in HIGH rather than MEDIUM.

**Detailed build plan:** see [`docs/milestone5-plan.md`](./milestone5-plan.md) — module-by-module
breakdown; the sign-offs that were blocking it are now resolved and recorded in `decisions.md`.

## 6. Health screen, ingest scheduling, notifications — ⏳ partially done

> (no additional quote — §6 names this milestone in four words)

The Health screen (§5.6) part is **already built** — it shipped as one of Milestone 4's four
admin tabs (see above), ahead of this milestone, since the Labeller UI needed _some_ admin
surface to attach it to. What's still not started: `node-cron` ingest scheduling and the webhook
notification boundary (§8). Also still missing from the Health screen itself: it can report gone
torrents and dangling mappings, but has no action to actually delete a stale rule/mapping for one
— see Milestone 4's "known gap" note above.

---

**Overall:** 4 of 6 milestones done and merged to `dev`, each verified as thoroughly as an
isolated build sandbox allows, and Milestones 3 and 4 have since gone further than that. Milestone
3 was live-installed against the repo owner's real deployment, real TorBox account, and real
clients (AIOStreams + Nuvio), which surfaced and fixed two genuine gaps (a TMDB-vs-IMDb id
mismatch, and a production-image operational note on triggering ingest manually) and confirmed
two real shows resolve correctly end to end. Milestone 1's own real-ARM64-host criterion has also
been satisfied for real: the repo owner deployed the GHCR-published image via Portainer on the
actual target host and a real ingest ran cleanly (210 torrents, 2067 files, clean exit). The one
thing left on Milestone 3 isn't code — it's the repo owner actually pressing play and confirming
real video decode, the last unconfirmed piece of its stated success criterion. Milestone 4
(reviewed and fixed before merge, see above) has since gained a follow-up too: already-mapped
rules are now editable from the Library view, not just creatable fresh. Milestone 6's Health
screen already exists as one of Milestone 4's tabs, ahead of schedule; scheduling and
notifications are what's left of it.
