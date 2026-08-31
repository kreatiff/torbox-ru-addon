# torbox-ru

Self-hosted Stremio addon mapping a TorBox cloud library (Russian TV, messy
non-Scene naming) to `(series, season, episode)` streams. Full design in
[`torbox-ru-addon-spec.md`](./torbox-ru-addon-spec.md).

Project history, every decision made, and per-milestone status live in
[`docs/`](./docs/) ([history](./docs/history.md) ·
[decisions](./docs/decisions.md) · [milestones](./docs/milestones.md) ·
[Milestone 5 plan](./docs/milestone5-plan.md)) —
kept there instead of the GitHub wiki, which this build couldn't get write
access to (see `docs/history.md`).

## Status

**Milestones 1-4 of 6 done and merged (locked build order, spec §6); Milestone
6's Health screen already shipped early as part of Milestone 4 (see below).**
Ingest (TorBox client, schema, migrations, `mylist` → Postgres with
snapshots) plus `expandRule`: pure, exhaustively tested, and verified end to
end against two hand-written SQL rules using the real examples from spec §1
(see `scripts/seed/milestone-2-example.sql`, `test/ingest/materialize.test.ts`).
Three of the four `numbering` modes are implemented (`sequential`,
`continuous`, `manual`); `parsed` throws a clear not-yet error until the
extractor cascade lands in Milestone 5, per the locked build order. The
Stremio-facing addon (`/manifest.json`, `/stream/series/:id.json`,
`/play/:fileId` — see "Milestone 3: the addon" below) is built. The admin
Labeller UI (see "Milestone 4: admin UI" below) is built, reviewed, and
merged, including a follow-up that made already-mapped rules editable from
the Library view, not just creatable fresh from the Queue.

A handful of decisions the spec left open (confidence formula, numbering-mode
semantics, an additive `provider_seasons` table, a couple of others) were
resolved with a stated default and flagged for sign-off rather than guessed
silently — see `torbox-ru-addon-plan.md`, or search this codebase for `§3.`
comments, which point back at the specific spec section each decision
responds to.

**TorBox API connectivity and the real ARM64-targeted Dockerfile are
verified**, first against a bad token (envelope shape `{success, error,
detail, data}` in `src/torbox/envelope.ts`/`schemas.ts` matched exactly
what `api.torbox.app` returns on an auth error) and since then against a
real account (see below). The full multi-stage Dockerfile builds
successfully and the resulting image, run against real Postgres, correctly
migrates and ingests. That first verification pass also caught and fixed a
real bug: `pg.Pool` had no `'error'` listener and `migrateUp()` wasn't
wrapped in error handling, so a DB-unreachable-at-boot condition crashed
the process instead of failing gracefully (see `decisions.md`).

**A successful ingest against a real TorBox account is now verified too.**
With a real `TORBOX_API_KEY` supplied, `getMylist()` pulled the repo owner's
actual library end to end: 210 torrents, 2067 files (1408 video), parsed
through `mylistResponseSchema` with zero schema mismatches. The real
library contains the exact spec §1 example torrents verbatim — including
the `Bolshoy.Kush...(1080р)` Cyrillic-`р` homoglyph case — and all of it,
plus the two Milestone 2 hand-written rules, round-tripped through Postgres
and `expandRule` correctly (42/42 tests passing against real Postgres 16;
18/18 files mapped to the right episodes). Re-running ingest a couple of
minutes later against the same live, changing account correctly upserted
with `torrentsNew: 0` and marked 2 newly-absent torrents `gone` — real
confirmation of the dedup and mark-gone paths, not just the happy path.
The full built container image (not just `tsc`/`vitest` on the host) was
also re-run against real Postgres and the live API with the same result.

**Still not verified:** a true `linux/arm64` build (this build sandbox's
nested-Docker QEMU emulation still doesn't work — re-confirmed with `docker
run --platform linux/arm64 node:22-alpine uname -m` → `exec format error`
— so the image is validated on the host's native architecture instead;
nothing in the codebase is architecture-specific). Separately,
`refreshWebdav()`'s force-refresh call still doesn't succeed: it needs
WebDAV Basic-auth credentials distinct from `TORBOX_API_KEY` (confirmed via
`WWW-Authenticate: Basic realm="TorBox WebDAV"`), which this repo doesn't
have. Harmless today — the call is best-effort and ingest doesn't depend on
it — but force-refresh itself needs those credentials from the repo owner
to ever actually work. See `decisions.md` for both.

**Milestone 3 (the addon) is built, sandbox-verified, and now also
installed against the repo owner's real deployment, real TorBox account,
and real clients (AIOStreams + Nuvio).** Manifest shape, constant-time
`:token` auth (valid/invalid/missing, all as a 404), and stream resolution
against real Postgres rows all pass in `test/http/`; `/play/:fileId`'s 302
redirect and `play_log` insert are verified against a mocked TorBox
response, and a dedicated test asserts `TORBOX_API_KEY` never appears in
any response body or header.

Real-world installation surfaced and fixed a genuine gap: AIOStreams
resolves some titles via **TMDB**, not IMDb, and the manifest originally
only declared IMDb (`tt...`) support — AIOStreams correctly filtered the
addon out client-side for those titles rather than sending a request that
would 404. Fixed by declaring both id schemes and teaching the stream route
to resolve either (see `docs/decisions.md`). Two real shows from the
owner's library have since been hand-mapped and confirmed resolving to the
correct files end to end: one where each episode is its own separate
torrent (four rules, one per torrent), and one with two overlapping
torrents for the same season — an earlier incomplete one and a later
complete one, both intentionally held per §4's mappings design, offering
two stream sources for the episodes they share.

**Still needs the repo owner**: actually pressing play and confirming a
`.ts` and an `.mp4` file play in a real client — that's Milestone 3's exact
stated success criterion, and everything above stops just short of it (real
resolution to the correct file, confirmed; real video decode, not yet
explicitly confirmed). See `docs/milestones.md` §3.

## Setup

```
cp .env.example .env   # fill in TORBOX_API_KEY, ADDON_TOKEN, PUBLIC_BASE at minimum
docker compose up
```

This builds the app image, starts Postgres, runs migrations, and starts the
addon server listening on `PORT` (default 3000) — it stays running (see
docker-compose.yml's comments). Ingest is still manual until Milestone 6's
scheduler lands:

```
docker compose exec app node dist/ingest/runOnce.js
```

Not `npm run ingest` — that script invokes `tsx` against the TypeScript
source, and the production image only ships the compiled `dist/` output
plus production dependencies (no `tsx`, no `src/`, found the hard way
running this against a real deployment). `npm run ingest` only works in
[local development](#local-development-without-docker), where the full dev
toolchain is installed.

### Deploying via Portainer (or Swarm, or any other UI-managed stack)

No `.env` file needed either way — every variable `app` reads comes through
plain `${VAR}` interpolation (`TORBOX_API_KEY`, `DATABASE_URL`,
`TORBOX_REQUEST_DELAY_MS`, `LOG_LEVEL`, `ADDON_TOKEN`, `PUBLIC_BASE`,
`PORT`, `NOT_WEB_READY_EXTENSIONS`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `ALLOWED_EMAILS`,
`TMDB_API_KEY`), not `env_file:`, specifically so a stack UI's own
"Environment variables" section can supply them.

**Option A — no clone at all.** `.github/workflows/docker-publish.yml`
builds and pushes `ghcr.io/kreatiff/torbox-ru-addon:latest` (and a
`:sha-<short>` tag) on every push to `dev`. Copy
[`docker-compose.ghcr.yml`](./docker-compose.ghcr.yml)'s contents straight
into Portainer's _Stacks → Add stack → Web editor_ (no git repository
needed), or run it directly with
`docker compose -f docker-compose.ghcr.yml up -d` on any host. Then under
the stack's **Environment variables** add at minimum:

```
TORBOX_API_KEY=<your real key>
ADDON_TOKEN=<generate with: openssl rand -hex 32>
PUBLIC_BASE=<https://your-cloudflare-tunnel-hostname>
GOOGLE_CLIENT_ID=<from Google Cloud OAuth client>
GOOGLE_CLIENT_SECRET=<from Google Cloud OAuth client>
SESSION_SECRET=<generate with: openssl rand -base64 32>
ALLOWED_EMAILS=<your-google-email@example.com>
```

`PUBLIC_BASE` is what gets embedded in every stream URL handed to Stremio,
so it needs to actually be reachable from wherever Stremio/AIOStreams run —
the Cloudflare Tunnel hostname in production, pointed at the stack's
exposed port (`PORT`, default 3000). `/admin` and `/api` are gated by Google
OAuth; only the comma-separated `ALLOWED_EMAILS` addresses can log in. The
OAuth client's authorized redirect URI must be
`${PUBLIC_BASE}/auth/google/callback`. `TMDB_API_KEY` is optional (the
Labeller's show picker just returns no results without it).

If the package is private (GHCR defaults new packages to the repo's
visibility), either make it public under the repo's _Packages_ tab, or add
a registry credential in Portainer (_Registries_) or run
`docker login ghcr.io -u <github-user>` on the host first, using a PAT with
`read:packages`.

**Option B — build from source.** Point a Portainer _Stack_ (Git
repository method, this repo/branch, `docker-compose.yml` as the compose
path) at it instead; Portainer clones the repo and builds the image itself
on `docker compose up`. Same environment variables as Option A.

Either way, everything except `TORBOX_API_KEY`, `ADDON_TOKEN`,
`PUBLIC_BASE`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`,
and `ALLOWED_EMAILS` (`DATABASE_URL`, `POSTGRES_USER`/`PASSWORD`/`DB`,
`LOG_LEVEL`, `TORBOX_REQUEST_DELAY_MS`, `PORT`, `NOT_WEB_READY_EXTENSIONS`,
`TMDB_API_KEY`) has a matching default already in the compose file and only
needs overriding if you want non-default Postgres credentials — in which case
set `POSTGRES_USER`/`PASSWORD`/`DB` _and_ a `DATABASE_URL` that matches them,
since the app connects with the latter, not the three parts. Leaving any of
the five required variables unset deploys fine but the container exits
immediately with a clear "... is required" error (`src/config.ts`) — check
the container logs.

## Local development (without Docker)

```
npm install
npm run migrate:up      # apply migrations to whatever DATABASE_URL points at
npm run ingest           # one ingest run
npm run dev               # starts the addon server against DATABASE_URL; no file-watch wired up, re-run manually after edits
```

## Milestone 2: hand-written rules

`scripts/seed/milestone-2-example.sql` inserts two titles/torrents/rules by
hand (the first two real examples from spec §1) against whatever
`DATABASE_URL` points at:

```
psql "$DATABASE_URL" -f scripts/seed/milestone-2-example.sql
```

`rebuildAllMappings()` (called automatically at the end of every ingest run,
or directly from `src/ingest/materialize.ts`) then reads those rules,
expands them, and writes `mappings`. `test/ingest/materialize.test.ts` does
the same thing against `TEST_DATABASE_URL` and asserts the result is exactly
right — that's the automated version of "verify expandRule materialises
correct mappings" from the build order.

## Milestone 3: the addon

Three routes, all under `/:token` (§5.5 — `ADDON_TOKEN`, constant-time
compared on every request; a wrong or missing token is a 404, not 401/403):

```
GET /:token/manifest.json
GET /:token/stream/series/:imdbId:season:episode.json
GET /:token/play/:fileId              -- 302 to a signed TorBox URL
```

With the server running (`npm run dev` or `docker compose up`) and a real
`ADDON_TOKEN`:

```
curl http://localhost:3000/$ADDON_TOKEN/manifest.json
```

The stream route resolves by IMDb id, which the Milestone 2 seed doesn't
set (those are fabricated example hashes, not real library data) — to try
it locally, point one of the seeded titles at a real `tt...` id first:

```
psql "$DATABASE_URL" -c "update titles set imdb_id = 'tt0000000' where name_ru = 'Сокровища императора'"
curl http://localhost:3000/$ADDON_TOKEN/stream/series/tt0000000:3:1.json
```

`/play/:fileId` (`fileId` from a stream response's `url`) 302s to a real,
signed TorBox CDN URL and never to a URL containing `TORBOX_API_KEY` — that
redirect is the entire point of the route (§5.5). `test/http/` covers all
three routes without needing a live deployment: manifest shape, token auth,
stream resolution against real Postgres rows, and the play redirect against
a mocked TorBox response.

Installing the manifest URL in real Stremio/AIOStreams and confirming
actual playback needs a real deployment reachable from those clients — see
the Status section above and `docs/milestones.md` §3.

### Catalog + meta (issue #20): "My TorBox Library" in Discover

Two more routes, added on top of the three above and under the same
`/:token` prefix/auth:

```
GET /:token/catalog/series/torbox-ru-library.json
GET /:token/catalog/series/torbox-ru-library/search=<query>&skip=<n>.json
GET /:token/meta/series/:idJson
```

The catalog lists every title with at least one mapped file, newest-mapped
first, with `search` and `skip` (Discover pagination) as optional extras.
Every card is advertised under this addon's own `torboxru:<uuid>` id, even
when the title also has an `imdb_id` — Stremio uses whichever installed
addon answers `meta` first for a shared id, and Cinemeta (which some
clients, e.g. Nuvio, can't reorder below other addons at all) would always
win a bare `tt…` id, silently reverting the title back to Cinemeta's
metadata. `/meta` serves the synthetic id's episode list and description
(see "Kinopoisk-backed meta" below), and still also answers plain `tt…`/
`tmdb:…` ids for backward compatibility. See `docs/decisions.md`'s
"Force synthetic ids for every title" section for the full reasoning.

**If you already have this addon installed, you need to reinstall it** for
the catalog to show up — Stremio caches a manifest per addon version, and
it doesn't reliably notice the bump on its own. Remove the addon and re-add
the same manifest URL; the library then appears under Discover → Series →
"My TorBox Library".

### Kinopoisk-backed `meta` (issue #28): real Russian descriptions, not Cinemeta's

`/meta` now answers for **every** title this library maps — `tt…` and
`tmdb:…` ids included, not just the `torboxru:<uuid>` ones issue #20
originally scoped it to. This is a deliberate reversal of that earlier
"let Cinemeta win for `tt` ids" decision: the point of this feature is
Russian-language description/genres/cast in place of Cinemeta's English
(or missing) ones, so this addon's own answer needs to win for every
mapped title. See `docs/decisions.md`'s "Kinopoisk-backed meta" section
for the full reasoning, including the accepted tradeoff (this addon now
also gets probed for `meta` on shows outside its library — a cheap,
null-returning lookup, same shape `stream.ts` already handles for unknown
stream ids).

Set `KINOPOISK_API_KEY` (a [kinopoiskapiunofficial.tech](https://kinopoiskapiunofficial.tech)
token) to enable it — optional, same soft-fail shape as `TMDB_API_KEY`:
without it, `/meta` still works, just without the enrichment fields. When
set, the **first** `/meta` request for a title with an `imdb_id` triggers
one Kinopoisk lookup (cached in `titles.kinopoisk_*` forever after, whether
or not a match was found) — every later request for that title is a plain
DB read, no repeat API calls. Titles with no `imdb_id` at all aren't
enriched in this pass (Kinopoisk's one reliable cross-reference here is
by-imdb-id search; see `docs/decisions.md` for why keyword matching wasn't
used instead).

## Milestone 4: admin UI

A React admin UI at `/admin` (Queue / Labeller / Library / Health tabs) plus
a JSON API at `/api/*`. Authentication is Google OAuth: a login page at
`/admin` redirects through Google, and only addresses in `ALLOWED_EMAILS`
can obtain a session. There is no registration flow. `TMDB_API_KEY` (v3
query-key or v4 Bearer/JWT, either works) is optional — without it the
Labeller's show picker just returns no results, nothing else depends on it.

Rules already mapped and showing in the Library tab are editable, not just
creatable from the Queue: each rule listed under a season has an **Edit**
button that opens the Labeller pre-filled with that rule's season, numbering,
sort, exceptions, and show — change anything and save to update it in place
(or move it to a different season; the old rule and its mappings are cleaned
up automatically rather than left behind).

Titles carry `tmdb_id`/`imdb_id`/`tvdb_id` together, not just one provider id,
so matching against RuTracker feed entries and AIOStreams/Stremio requests
stays reliable even when a show is missing one of the three. Whenever a
title is created or edited with at least one id, the server cross-references
TMDB (`GET /api/titles/resolve`) to backfill whichever of the other two it
can find — pick a TMDB show from search and its IMDb/TVDB ids get filled in
automatically; paste just an IMDb or TVDB id and TMDB resolves the rest. The
Library tab's **Add Title** button (and each card's **Edit** action) exposes
this directly: search TMDB, or type any combination of the three ids and
name/year/poster by hand, click **Resolve IDs** to preview what TMDB
cross-references before saving, then save either way.

In the Library tab's episode-coverage grid, a green box means exactly one
file is mapped to that episode; orange means more than one file mapped to
the same episode number (hover for a tooltip listing which files — this can
be intentional, e.g. two overlapping torrents kept as alternate sources for
the same episode, or it can mean a rule picked up an extra file it shouldn't
have); an empty/bordered-only box means no file is mapped to that episode at
all.

**Known gap:** there's no way yet to delete a rule/mapping for a torrent
that's gone from TorBox. The Health tab's "Gone Torrents" and "Dangling
Mappings" numbers are read-only diagnostics with no delete action attached.

With the server running and an authenticated session cookie:

```
curl -b session=<your-session-cookie> http://localhost:3000/api/queue
```

The UI itself is a separate npm workspace (`ui/`) that needs its own install
and build — not run automatically by the root `npm run build`/`npm run dev`:

```
cd ui && npm install && npm run build   # outputs to ../dist/ui, served at /admin
```

`docker compose up` builds the UI automatically (a dedicated Dockerfile
stage) — this manual step is only needed for local development without
Docker. Without a build present, `/admin/*` 404s with a clear message rather
than failing silently (`src/http/routes/admin/index.ts`).

### Russian-only auto-match

The LLM auto-proposal step (OpenCode Zen) that turns a newly-ingested
torrent into a Library title now only auto-creates a title when TMDB's
`original_language` for the best match is `"ru"` — this is a Russian-tracker
addon, and without this gate a confidently-extracted English show/movie on
RuTracker got auto-added exactly like a real one. A non-Russian match just
queues the torrent for manual review, same as any other unresolved match —
nothing new is created. See `docs/decisions.md`'s "Russian-only auto-match
gate" section.

This doesn't touch anything already in the library from before the fix. To
find (and optionally remove) titles that were wrongly auto-added by past
runs, either:

- **Health tab → "Non-Russian Titles Audit"** — click **Scan Library**,
  review the flagged titles (name, TMDB language, rule/mapping counts),
  delete individual ones with the trash icon (confirms before deleting).
- Or the same scan/delete from the CLI:

  ```
  npx tsx --env-file=.env scripts/audit-non-russian-titles.ts            # report only
  npx tsx --env-file=.env scripts/audit-non-russian-titles.ts --delete   # report + delete
  ```

Both share the same logic (`src/library/nonRussianAudit.ts`) and re-check
every title's *live* TMDB `original_language` (nothing is cached), so both
need `TMDB_API_KEY` configured; titles with no `tmdb_id` can't be checked
this way and are skipped either way. The scan can take a while on a large
library — one TMDB call per title, throttled.

## Testing

```
npm test                 # pure unit tests (normalize/extract/torbox schemas) — no Postgres needed
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/db npm test   # also runs db/ and ingest/ integration tests
```

Integration tests truncate and reuse whatever database `TEST_DATABASE_URL`
points at — use a throwaway/dev database, never a real one. Migrations must
already be applied there (`npm run migrate:up` with `DATABASE_URL` set to the
same value).

```
npm run typecheck
npm run lint
npm run format:check
```
