# torbox-ru

Self-hosted Stremio addon mapping a TorBox cloud library (Russian TV, messy
non-Scene naming) to `(series, season, episode)` streams. Full design in
[`torbox-ru-addon-spec.md`](./torbox-ru-addon-spec.md).

## Status

**Milestone 1 of 6 (locked build order, spec §6): ingest only.** TorBox
client, schema, migrations, `mylist` → Postgres with snapshots. No matching,
no UI, no addon routes yet — those are Milestones 2–5.

A handful of decisions the spec left open (confidence formula, numbering-mode
semantics, an additive `provider_seasons` table, a couple of others) were
resolved with a stated default and flagged for sign-off rather than guessed
silently — see the plan/first-response written before this code, or search
this codebase for `§3.` comments, which point back at the specific spec
section each decision responds to.

**Not yet verified against the real TorBox API.** The sandbox this was built
in has no network path to `api.torbox.app` or Docker Hub (org egress
policy), so `src/torbox/schemas.ts` is a best-effort reconstruction from the
spec's own data model rather than a live-verified response shape, and the
Docker image has never actually been built/run. Everything else — migrations,
the full DB layer, the ingest pipeline's branching logic (inline files vs.
per-id fallback, mark-gone, re-activation) — is tested against a real
Postgres 16 and passes. The first real `docker compose up` on the actual
Oracle Cloud host is the real test of the TorBox-facing code; expect to patch
field names in `schemas.ts` from whatever the real response logs.

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
