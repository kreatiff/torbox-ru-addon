# Milestone status

Status against the locked build order (`torbox-ru-addon-spec.md` §6 — "do not skip ahead").
Updated as of Milestone 2 shipping. See [`decisions.md`](./decisions.md) for the reasoning
behind specific choices, and [`../README.md`](../README.md) for how to actually run any of this.

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

**Still not verified:** a successful ingest against a real account (no `TORBOX_API_KEY` is
available in this environment), and a true `linux/arm64` build (this sandbox's nested-Docker
QEMU emulation is non-functional — confirmed by isolating the failure down to `uname -m` under
`--platform linux/arm64` failing the same way — so the image was validated on the host's native
architecture instead; nothing in the codebase is architecture-specific).

**To actually run this for real, the repo owner needs to:** supply a real `TORBOX_API_KEY`,
and run `docker compose up` on the actual Oracle Cloud ARM64 host.

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

## 3. Manifest + stream + play — ⏳ not started

> Install in Stremio and in AIOStreams as a custom addon. Confirm actual playback of a `.ts`
> file and an `.mp4` file. The data model is free to change until this works and expensive to
> change after.

Not yet built: `src/http` doesn't exist yet. This is the next milestone in sequence.

**Why it's paused here rather than in progress:** this milestone's own success criterion —
real playback confirmed inside real Stremio and AIOStreams clients — needs the repo owner's
real TorBox account, a deployed instance reachable from those clients, and the clients
themselves. That's not achievable from an isolated build sandbox. The plan is to build and test
everything that *can* be verified without a live deployment (manifest shape, token
constant-time auth, stream-URL construction, the `/play/:fileId` redirect logic against a
mocked TorBox response) and then hand off the live-playback confirmation step.

**Needs from the repo owner before this can be verified for real:** `ADDON_TOKEN`,
`PUBLIC_BASE` (the Cloudflare Tunnel hostname), and the deployed instance itself.

## 4. Labeller UI — ⏳ not started

> Queue, labeller, preview table.

Not started. Per the plan document's §3.6, this milestone's show picker needs *some* metadata
search working (`src/metadata/`, notionally Milestone 5 scope) — the plan proposes folding a
minimal TMDB-only `searchTitles` into this milestone rather than reordering anything, since the
picker can't function without it. Needs `TMDB_API_KEY` from the repo owner when it starts.

## 5. Auto-proposal engine — ⏳ not started

> Extractor cascade, normalisation, confidence scoring.

Not started. This is where `src/normalize/` and the rest of `src/extract/` (only
`naturalSort.ts` exists so far, pulled forward into Milestone 2 — see decisions log) get built,
along with `numbering: 'parsed'` mode, `proposeRule`, and the confidence formula. Two
Tier-1 items from the plan document are explicitly **pending sign-off** before this can start
in earnest: the three-tier confidence-materialisation reading (§3.3 of the plan) and a concrete
confidence formula (§3.4) — both flagged as consequential given the spec's own warning (§9)
that a confident-but-wrong mapping is the worst failure mode in the system.

## 6. Health screen, ingest scheduling, notifications — ⏳ not started

> (no additional quote — §6 names this milestone in four words)

Not started. `node-cron` scheduling, the webhook notification boundary (§8), and the Health
screen (§5.6) all land here, on top of whatever the Labeller UI (Milestone 4) establishes for
the admin surface.

---

**Overall:** 2 of 6 milestones done, both verified as thoroughly as an isolated build sandbox
allows. The next real blocker isn't code — it's the repo owner's live TorBox account and
Oracle Cloud host, needed to actually confirm Milestone 1's ingest and unblock Milestone 3's
playback requirement.
