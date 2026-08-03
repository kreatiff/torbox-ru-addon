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

**TorBox API connectivity and the real ARM64-targeted Dockerfile are now
verified**, once the build sandbox's network policy was opened up. Confirmed
against the live API (with an invalid token, since no real account is
available here): the envelope shape `{success, error, detail, data}` in
`src/torbox/envelope.ts`/`schemas.ts` matches exactly what
`api.torbox.app` actually returns on an auth error. The full multi-stage
Dockerfile builds successfully and the resulting image, run against real
Postgres, correctly migrates, attempts ingest, hits the real API, and fails
cleanly on the bad token — no crash. That verification pass also caught and
fixed a real bug: `pg.Pool` had no `'error'` listener and `migrateUp()`
wasn't wrapped in error handling, so a DB-unreachable-at-boot condition
crashed the process instead of failing gracefully (see `decisions.md`).

**Still not verified:** an actual *successful* ingest against a real TorBox
account (no API key is available in this environment — only connectivity
and the error-response shape were confirmed), and a true `linux/arm64` build
(this sandbox's nested-Docker QEMU emulation doesn't work — even `uname -m`
fails under it — so the Dockerfile was validated on the host's native
architecture instead; nothing in the codebase is architecture-specific).

## Setup

```
cp .env.example .env   # fill in TORBOX_API_KEY at minimum
docker compose up
```

This builds the app image, starts Postgres, runs migrations, and does one
ingest run (logs a summary, then exits — see docker-compose.yml's comments;
this changes shape once Milestone 3/6 land).

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
