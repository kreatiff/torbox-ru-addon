# torbox-ru

Self-hosted Stremio addon mapping a TorBox cloud library (Russian TV, messy
non-Scene naming) to `(series, season, episode)` streams. Full design in
[`torbox-ru-addon-spec.md`](./torbox-ru-addon-spec.md).

Project history, every decision made, and per-milestone status live in
[`docs/`](./docs/) ([history](./docs/history.md) ·
[decisions](./docs/decisions.md) · [milestones](./docs/milestones.md)) —
kept there instead of the GitHub wiki, which this build couldn't get write
access to (see `docs/history.md`).

## Status

**Milestones 1-2 of 6 done (locked build order, spec §6).** Ingest (TorBox
client, schema, migrations, `mylist` → Postgres with snapshots) plus
`expandRule`: pure, exhaustively tested, and verified end to end against two
hand-written SQL rules using the real examples from spec §1 (see
`scripts/seed/milestone-2-example.sql`, `test/ingest/materialize.test.ts`).
Three of the four `numbering` modes are implemented (`sequential`,
`continuous`, `manual`); `parsed` throws a clear not-yet error until the
extractor cascade lands in Milestone 5, per the locked build order. No
addon routes or UI yet — Milestones 3-4.

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

## Setup

```
cp .env.example .env   # fill in TORBOX_API_KEY at minimum
docker compose up
```

This builds the app image, starts Postgres, runs migrations, and does one
ingest run (logs a summary, then exits — see docker-compose.yml's comments;
this changes shape once Milestone 3/6 land).

### Deploying via Portainer (or Swarm, or any other UI-managed stack)

No `.env` file needed either way — every variable `app` reads comes through
plain `${VAR}` interpolation (`TORBOX_API_KEY`, `DATABASE_URL`,
`TORBOX_REQUEST_DELAY_MS`, `LOG_LEVEL`), not `env_file:`, specifically so a
stack UI's own "Environment variables" section can supply them.

**Option A — no clone at all.** `.github/workflows/docker-publish.yml`
builds and pushes `ghcr.io/kreatiff/torbox-ru-addon:latest` (and a
`:sha-<short>` tag) on every push to `dev`. Copy
[`docker-compose.ghcr.yml`](./docker-compose.ghcr.yml)'s contents straight
into Portainer's *Stacks → Add stack → Web editor* (no git repository
needed), or run it directly with
`docker compose -f docker-compose.ghcr.yml up -d` on any host. Then under
the stack's **Environment variables** add at minimum:

```
TORBOX_API_KEY=<your real key>
```

If the package is private (GHCR defaults new packages to the repo's
visibility), either make it public under the repo's *Packages* tab, or add
a registry credential in Portainer (*Registries*) or run
`docker login ghcr.io -u <github-user>` on the host first, using a PAT with
`read:packages`.

**Option B — build from source.** Point a Portainer *Stack* (Git
repository method, this repo/branch, `docker-compose.yml` as the compose
path) at it instead; Portainer clones the repo and builds the image itself
on `docker compose up`. Same environment variables as Option A.

Either way, everything except `TORBOX_API_KEY` (`DATABASE_URL`,
`POSTGRES_USER`/`PASSWORD`/`DB`, `LOG_LEVEL`, `TORBOX_REQUEST_DELAY_MS`)
has a matching default already in the compose file and only needs
overriding if you want non-default Postgres credentials — in which case
set `POSTGRES_USER`/`PASSWORD`/`DB` *and* a `DATABASE_URL` that matches
them, since the app connects with the latter, not the three parts. Leaving
`TORBOX_API_KEY` unset deploys fine but the container exits immediately
with a clear "TORBOX_API_KEY is required" error (`src/config.ts`) — check
the container logs.

## Local development (without Docker)

```
npm install
npm run migrate:up      # apply migrations to whatever DATABASE_URL points at
npm run ingest           # one ingest run
npm run dev               # same, but re-runs on file changes are not wired up (Milestone 1 has no server loop yet)
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
