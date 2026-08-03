# torbox-ru: first response to the spec (§10)

> **Status (post-Milestone-1):** this is the design checkpoint written and approved before any
> code existed, kept here as the record of that decision. Milestone 1 (ingest only) has since
> shipped — see `README.md` for current status. One deviation worth flagging: the integration-test
> plan below (§4 table) specifies `testcontainers-node`; the build environment's egress policy
> blocked Docker Hub pulls, so tests instead point `TEST_DATABASE_URL` at any reachable Postgres
> 16 (see `test/db/testDb.ts`, `README.md`). Tier-1 open items in §3 (numbering-mode semantics,
> confidence tiers/formula, the `provider_seasons` schema addition, `titles` dedup, Milestone 4/5
> metadata sequencing) were not blocking for Milestone 1 and are still open pending sign-off
> before Milestone 2.

## Context

`torbox-ru-addon-spec.md` §10 asks explicitly for a checkpoint before any code exists: restate
the architecture, list what's underspecified or disputable, propose the file tree, then stop.
The repo currently contains only that spec file and a stock `.gitignore` — nothing to migrate
or preserve, so this is a from-scratch design, not a refactor. Everything below is that
checkpoint. Once you sign off (even partially — you can approve some items and redirect others),
I start Milestone 1 per the locked build order.

---

## 1. The architecture, restated

The system's only real job is turning a messy string (a torrent name, a filename) into a
`(title, season, episode)` triple, and doing it in a way that's cheap to correct when it's
wrong — because on this content (Russian TV, non-Scene releases, mixed Cyrillic/Latin
homoglyphs) it *will* be wrong regularly, and a system that makes corrections expensive is a
system that stops getting corrected. That's why §3.7 calls the rule-vs-mapping split "the
single most important structural decision": a `rule` encodes *how to count* a torrent's files
("start at episode 1, natural sort" / "subtract 12 for the absolute-to-relative offset" /
"episode 4 is actually a trailer, ignore it"), and `mappings` is a disposable, rebuild-anytime
cache of applying that rule. Fixing an off-by-one is one write, not forty.

Two things are foundational and cut across every module: **homoglyph normalisation** runs
before any pattern match touches a string, because Cyrillic/Latin lookalikes silently break
naive regexes (the `1080p`/`1080р` pair is the running example, but it recurs anywhere a
releaser's fingers slipped keyboard layout mid-string); and **cross-validation drives
confidence**, not regex cleverness — a single strong-looking match (an explicit `SxxExx`) is
worth less than agreement between independent signals (file count, provider episode count,
air dates), because a parser that's *confident* and *wrong* is explicitly called out (§9) as
the worst failure mode the system can produce.

The pipeline has three logically separate stacks. A **pure stack**
(`normalize → extract → resolve`) does the actual parsing/scoring logic with zero I/O — this
is deliberate, not incidental: `expandRule` has to be pure so it's exhaustively unit-testable
(§7) and, as I'll argue below, so it can run **client-side** in the Labeller's live preview
table. An **infra stack** (`db`, `torbox`, `metadata`) talks to Postgres and the outside world
and needs config/logging but nothing from the pure stack. An **orchestration layer**
(`ingest`, `http`) is the only code allowed to depend on both — `ingest` runs the pipeline in
§5.2, `http` serves the addon and the admin API. This isn't a restructuring of the spec's
module list, it's the dependency shape *underneath* the six modules the spec already names
(§5.1–5.6), and it's why a couple of extra top-level directories (`db/`, `normalize/`,
`extract/`, plus leaf files `config.ts`/`logger.ts`) earn their place rather than nesting
inside the six named ones — see §5 below for the one-line reason each.

Everything is keyed internally on `titles.id`, never `imdb_id`, because IMDb coverage is
incomplete for this content class (§4). Ingest snapshots (`raw_name_at_ingest`) are immutable
by design so parsing is always reproducible against what was actually true at ingest time,
decoupled from whatever TorBox shows live later. The addon never exposes a TorBox-signed URL
directly — every stream points at `/play/:fileId`, which fetches the signed URL server-side
and 302s the client, both to keep `TORBOX_API_KEY` out of anything Stremio/Nuvio might cache or
log, and because it's the only point in the system that observes which mappings are *actually*
being watched (`play_log`) versus quietly wrong. Auth is deliberately minimal and two-tiered:
a single shared `ADDON_TOKEN` in the URL path gates the public Stremio-protocol routes (no
per-user concept — this is a single-operator tool), and HTTP Basic Auth gates the admin UI and
its JSON API, both sitting behind a Cloudflare Tunnel that's assumed to provide no auth of its
own.

The build order (§6) exists to de-risk the data model first: ingest real data, hand-write two
SQL rules, prove `expandRule` and real playback (both a `.ts` and an `.mp4`, in both Stremio
and AIOStreams) before a single line of parsing/normalisation code exists, because the schema
is "free to change until [Milestone 3] and expensive to change after." Everything in §3 (the
actual hard part — homoglyphs, masking, the extractor cascade, confidence scoring) is
Milestone 5, deliberately last.

---

## 2. Where I'd push back on the spec

Two small, non-LOCKED points:

- **Manifest `"types": ["series", "movie"]`.** Movies are an explicit v1 non-goal (§8) and the
  pipeline is series-first throughout. Advertising `movie` support Stremio will then get empty
  results for seems like exactly the kind of silent gap the spec elsewhere insists on
  surfacing rather than hiding. I'd ship `"types": ["series"]` for v1 and add `movie` back when
  it's real. This line isn't marked LOCKED (unlike its neighbors in §5.5), so flagging rather
  than just doing it.
- **WebDAV mount discovery shouldn't need FUSE inside the app container.** `TORBOX_MOUNT_PATH`
  is read-only-optional and, importantly, **off the streaming critical path entirely** —
  playback goes through TorBox's `requestdl` API keyed by `torbox_file_id`, never through a
  filesystem path. So I'd skip building `davfs2`/FUSE into the Docker image (real added
  complexity for an unscheduled, optional feature — it appears in no Build Order milestone),
  but still leave `docker-compose.yml` able to bind-mount a host-level WebDAV mount read-only
  if you already have `rclone`/`davfs2` running on the Oracle Cloud box outside Docker. Costs
  nothing to leave the seam in; costs a FUSE device grant and an extra package to build it into
  the image now for a feature nothing currently schedules.

---

## 3. Where the spec is underspecified

### Tier 1 — touches the data model or a §9 failure mode; want your call before/at Milestone 2

**3.1 — Exact semantics for the four `numbering` modes (needed almost immediately: Milestone 2
is "verify `expandRule` materialises correct mappings").** The spec gives the type shape
(§3.7) but not the per-mode algorithm. My reading, for sign-off:

  - `sequential` — skip parsing entirely. Sort files (`sort` field), assign
    `episode = startEpisode + index`. This is the deliberate-human-override mode: "don't even
    try to interpret these filenames, just count them in order" (the `01 выпуск.mp4 …`
    examples in §1 could use this *or* `parsed`, since the leading number happens to agree
    with position — but a torrent with no visible numbers at all needs `sequential`).
  - `parsed` — run the full extractor cascade (§3.5, stages 1–5 including its own positional
    fallback) per file. Differs from `sequential` in that it still *tries* SxxExx / word+number
    / air-date matching before falling back to position.
  - `continuous` — like `parsed`, but the cascade yields an absolute number (via
    `absolute_hint` or position) and `episode = absolute_number − absoluteOffset`, where
    `absoluteOffset` = the cumulative episode count of every season before this one. Worked
    example from the Bolshoy Kush torrent: season 1 had 12 episodes, absolute 14 → offset 12 →
    episode 2. `absoluteOffset` must already be a plain number sitting on the `rules` row —
    either entered by a human in the Labeller or computed by `proposeRule` from cached
    provider season counts (see 3.2) — `expandRule` stays pure and never looks anything up
    live.
  - `manual` — the `exceptions` map is authoritative for every file in scope; nothing else
    runs.
  - In all four modes, `exceptions` is checked first, per file, as an override — a file listed
    there (including `'ignore'`) never reaches the mode's normal logic.

**3.2 — §4's schema has no home for the provider data §5.3/§5.4/§5.6 all require.** Confidence
scoring needs "file count matches provider's episode count for that season"; the Labeller's
validation banners need to *display* that count; the air-date extractor stage (§3.5.3) needs
per-episode air dates; the show picker needs "per-season episode counts." None of that fits on
`titles` as given. Since you called §4 "close to final," I want a nod on an additive table
rather than silently extending it:

  ```sql
  provider_seasons (
    title_id      uuid references titles(id) on delete cascade,
    season        integer not null,
    source        text not null,             -- 'tmdb' | 'tvdb'
    episode_count integer not null,
    episodes      jsonb not null default '[]', -- [{episode, air_date}], powers §3.5.3
    fetched_at    timestamptz not null default now(),
    primary key (title_id, season, source)
  )
  ```
  Keyed by `(title, season, source)` so TMDB and TVDB each cache their own view of the same
  season — which also gives us an answer to "what if TMDB and TVDB disagree on episode count"
  (currently unaddressed by the spec): keep both, let confidence scoring/the UI show either or
  prefer a configured source order, rather than forcing a single merged number. I'd also add
  `titles.poster_url text` in the same migration — §5.6 wants a poster in the show picker and
  there's currently no column for one.

  **Status: implemented as written** in `migrations/1785725439402_provider-cache.ts`, pending
  sign-off same as the rest of this tier.

**3.3 — Confidence materialisation: I don't think "auto-commit" vs "queue for review" (§3.4)
are two flavors of the same outcome, and getting this wrong is precisely the §9 worst-case
("a plausible-but-wrong mapping... looks like it worked").** My reading, using only mechanisms
the spec already has (no schema change needed beyond 3.2):
  - High confidence → insert the `rule` **and** immediately materialise `mappings` for it.
    Fully live, no warning.
  - Medium confidence → insert the `rule` and materialise `mappings`, but the stream
    `description` carries the ⚠ (this is the only way `lowConfidence ? ' ⚠' : ''` in §5.5 ever
    fires — if nothing below "high" ever got materialised, that template branch would be dead
    code).
  - Positional-fallback-only → insert the `rule` but **do not** run `rebuildMappings` for it.
    It sits in the Queue, produces no Stream results yet, and only gets materialised once you
    hit `a`/accept (which reuses the same idempotent rebuild §4 already describes as "safe to
    rebuild"). This is what §5.3's table means by "always queue for review" being stated as an
    action rather than a weight — it's a hard floor, not just a low score.

  If this three-way read is wrong, the Queue screen's query and the ingest pipeline's "notify
  if anything needs review" step both need to know the real rule, so I'd rather get it now than
  guess through Milestone 5.

**3.4 — No numeric confidence formula exists, only relative weights.** Strawman for reaction,
not a request to bless exact numbers yet (I'll tune it against `test/fixtures/` at Milestone 5
regardless):
  - Each §5.3 signal that fires contributes high=+3 / medium=+1; "positional fallback used"
    contributes nothing but sets the hard floor from 3.3 above regardless of the sum.
  - Score = fired-points / max-possible-points *for signals that apply to this torrent's shape*
    (a single-file torrent can't fail "every file yielded SxxExx" the same way a 13-file one
    can, so it shouldn't be penalized for signals that don't apply).
  - High tier (auto, no ⚠): score ≥ 0.8 **and** at least one high-weight signal actually fired
    — a pile of medium signals summing high shouldn't silently auto-commit the way one clean
    high signal should.
  - Medium tier (⚠): 0.4 ≤ score < 0.8, or ≥0.8 without a qualifying high signal.
  - Floor tier (withheld): score < 0.4, or positional-fallback-only per 3.3.

**3.5 — `titles` dedup has a real hole.** Only `imdb_id` is `unique`, and it's nullable —
meaning the shows most likely to lack an IMDb entry (the exact case the spec calls out) get
zero duplicate protection if the show picker is used twice for the same real show. Proposing
nullable-unique constraints on `tvdb_id`/`tmdb_id` too (same pattern as the existing `imdb_id`
constraint), plus a `titlesRepo.findOrCreate` that looks up by provider ID before inserting.

  **Status: constraints implemented** in `migrations/1785725438965_init-schema.ts`
  (`titles_tvdb_id_key`, `titles_tmdb_id_key`); `findOrCreate` itself waits for `titlesRepo`,
  which isn't built yet (Milestone 4).

**3.6 — Build-order/module sequencing gap.** Milestone 4 (Labeller UI) needs a working show
picker, which needs `src/metadata` search — but metadata work reads as implicitly scheduled in
Milestone 5 (auto-proposal engine). This doesn't reorder anything LOCKED; I'd fold a minimal
`searchTitles` (TMDB only, see 3.7) into Milestone 4's scope so the picker has something to
query, and leave TVDB plus the full extractor-driven `proposeRule` cascade for Milestone 5 as
written.

### Tier 2 — scoped to one module; proposing a default, flagging for awareness

- **TVDB adds real, asymmetric complexity.** TVDB v4 needs a login → JWT → ~1-month-expiry →
  re-login state machine; TMDB is a static bearer key. Both already cover Russian-language
  fields and episode/air-date data per §5.4. I'd build `metadata/` behind a provider-agnostic
  interface, ship TMDB only first, and add `tvdb.ts` as a fast-follow once the pipeline's
  proven — unless you already know of specific shows where TMDB has a real coverage gap TVDB
  fills, in which case it should move earlier.
- **Homoglyph inspector directionality.** §3.1's fold table is one-directional
  (Cyrillic→Latin) — correct for *normalisation*, since matching always wants to fold toward
  Latin. But the UI inspector's job (§5.6) is "any character whose script differs from the
  surrounding run," demonstrated by a Cyrillic р stranded in an otherwise-Latin token — which
  the existing table happens to catch, but the reverse case (a stray Latin letter dropped into
  a Cyrillic word) wouldn't be. Proposing a bidirectional confusables table plus a
  per-token majority-script heuristic for the inspector specifically (normalisation itself
  stays one-directional).
- **No published TorBox rate limit.** Shipping a conservative, env-configurable default
  (small fixed delay between per-torrent file fetches) and tuning from real `429`s rather than
  inventing a number now. **Status: implemented** (`TORBOX_REQUEST_DELAY_MS`, default 250ms,
  `src/torbox/rateLimit.ts`).
- **Mount-discovery collision policy.** If two files share `(basename, size)` during the
  optional mount walk, I'd leave `mount_path` null rather than guess — same
  silent-wrong-mapping risk as everywhere else in this system, just on the optional path.

### Tier 3 — noting, not blocking

- `play_log.file_id` has no FK, unlike every other referencing column in §4 — reads as
  intentional (audit data that should survive independent of the row it references, same
  spirit as `raw_name_at_ingest` never being touched), flagging so it's not read as an
  oversight rather than silently copying a pattern I don't understand.

---

## 4. Decisions I'm making where the spec explicitly left the call to me

| Area | Decision | Why |
|---|---|---|
| Migrations + data access | **node-pg-migrate**, migration bodies as near-verbatim `pgm.sql(...)` wrapping §4's DDL, **not Drizzle**. Hand-written repository functions over plain `pg`, zod-validated at every read boundary. | §4's DDL is already final-ish with load-bearing comments (`imdb_id` nullable-not-PK, `mappings` PK is `file_id` alone). An ORM means maintaining a second schema representation that has to stay bit-for-bit synced with SQL that already says exactly what it means — pure translation risk for a write surface that's only ~25-30 query functions. zod at the read boundary gets the type-safety win without the sync risk, and the spec already mandates zod for the TorBox client anyway. First risk to spike in Milestone 1: node-pg-migrate's TS-under-ESM story can be finicky — falling back to `.cjs` migration files if it fights the toolchain. **Status: spiked clean in Milestone 1 — `.ts` migrations work natively (node-pg-migrate v9 ships a jiti-based loader), no `.cjs` fallback needed.** |
| Live preview table (§5.6) | `PreviewTable.tsx` calls `expandRule` **client-side**, bundled directly into the Vite SPA — no `/api/rules/preview` endpoint. | `expandRule` is contractually pure (§5.3: "no I/O, no DB"), which means it's safe to ship to the browser. The spec calls the live-updating preview "non-negotiable" for catching off-by-ones as controls change — a network round-trip per keystroke can't beat an in-browser call, and this is a direct, load-bearing consequence of the purity requirement rather than a nice-to-have. |
| Admin auth structure | One Fastify plugin scope for everything admin-facing, `addHook('preHandler', verifyBasicAuth)` called once, then nested `.register()` for both `/admin` (SPA static assets) and `/api` (JSON, including `POST /api/ingest/run`). | Fastify's hook inheritance follows plugin encapsulation, not URL prefix — a hook added in a parent applies to every nested `.register()` regardless of that child's own prefix. This closes a real gap: the spec writes `POST /api/ingest/run` without an `/admin` prefix, so left alone it'd be the one unauthenticated way to trigger work against the TorBox API. |
| Test runner | **Vitest**, split into a fast path (`normalize`/`extract`/`resolve`/`torbox` schemas — no external deps, runs on every save) and a slower integration path (`db`/`http`, backed by `testcontainers-node` spinning ephemeral Postgres 16) via two npm scripts. | TS/ESM-native, good fixture-table DX for §7's fixture-driven tests. Real Postgres semantics (constraints, upserts) matter enough for the `db/` tests that an in-memory shim would test the wrong thing. **Status: revised in Milestone 1 — the build sandbox's egress policy blocked Docker Hub, so `testcontainers-node` was dropped in favor of a plain `TEST_DATABASE_URL` env var pointing at any reachable Postgres 16, gated via `describe.skipIf(!hasTestDb)`. Revisit `testcontainers` if/when tests need to run somewhere without one available.** |
| UI packaging | npm workspaces: root `package.json` (server deps) + `src/ui/package.json` (React/Vite/TanStack Query). | Keeps server and browser dependency graphs from mixing without reaching for a heavier monorepo tool the project doesn't need at this size. Not yet added — `src/ui` doesn't exist until Milestone 4. |
| Docker | Multi-stage `Dockerfile` (SPA build stage → Node 22 ARM64 runtime stage that copies the built SPA, compiles TS, runs migrations on boot, then starts Fastify). `docker-compose.yml`: exactly `app` + `postgres`, per §2. | Matches "single service, plus Postgres" literally; migrate-on-boot keeps deployment to one `docker compose up` for a single-operator tool. **Status: Milestone 1's Dockerfile has no SPA stage yet (nothing to build until `src/ui` exists); `docker compose config` validates cleanly but the image has never actually been built — the sandbox's egress policy blocks Docker Hub too. First real build happens on the actual Oracle Cloud host.** |
| Lint/format/Node pin | ESLint flat config + Prettier + `.nvmrc` (`22`). | Not mentioned in the spec; cheap standard hygiene, not treating this as worth a question. |

---

## 5. Proposed file tree

One-line reason next to anything not a direct translation of §5's module list.

```
torbox-ru-addon/
├── .gitignore                          # existing
├── .env.example                        # every env var used anywhere below, commented
├── .nvmrc                              # "22"
├── .dockerignore
├── .prettierrc.json / .prettierignore
├── eslint.config.js                    # flat config, ESM+TS strict
├── package.json                        # root workspace: "workspaces": ["src/ui"]
├── tsconfig.base.json                  # shared strict/ESM options
├── tsconfig.json                       # server project, excludes src/ui
├── vitest.config.ts
├── docker-compose.yml                  # app + postgres only
├── Dockerfile                          # multi-stage: ui-build -> server runtime
│
├── migrations/
│   └── <ts>_init-schema.ts             # pgm.sql(...) wrapping §4 DDL near-verbatim
│   └── <ts>_provider-cache.ts          # provider_seasons + titles.poster_url — see §3.2, §3.5
│
├── src/
│   ├── index.ts                        # config -> migrate -> build http server -> scheduler -> listen
│   ├── config.ts                       # zod-validated env schema, typed singleton
│   ├── logger.ts                       # single pino instance shared everywhere
│   │
│   ├── normalize/                      # §3.1 — pure, zero deps, isomorphic (imported by src/ui too)
│   │   ├── homoglyphMap.ts             # confusables, bidirectional for the inspector — see §3 Tier 2
│   │   ├── normalise.ts
│   │   └── index.ts
│   │
│   ├── extract/                        # §3.2–3.5 — pure, depends only on normalize
│   │   ├── types.ts
│   │   ├── vocabulary.ts               # серия|выпуск|эпизод|... regex builder, §3.3
│   │   ├── maskTokens.ts               # §3.2 ordered masking pipeline
│   │   ├── qualityCodecTokens.ts       # quality/codec/release-group lists, configurable
│   │   ├── airDate.ts                  # "Эфир от DD.MM.YYYY"
│   │   ├── xOfY.ts                     # §3.4, incl. "A-B из Y" range form
│   │   ├── seasonEpisode.ts            # cascade stage 1: SxxExx incl. s02.E04 separators
│   │   ├── episodeNumber.ts            # cascade stage 2: number+word / word+number
│   │   ├── naturalSort.ts              # shared by cascade stage 5 and resolve's sort:'natural'
│   │   ├── cascade.ts                  # 5-stage priority orchestration, §3.5
│   │   └── index.ts
│   │
│   ├── resolve/                        # §5.3 — expandRule pure; proposeRule near-pure
│   │   ├── types.ts                    # Rule, RuleProposal, Mapping — spec-verbatim
│   │   ├── numbering.ts                # 4 mode strategies — see §3 Tier-1 semantics above
│   │   ├── expandRule.ts               # no I/O, no DB — also bundled client-side, see §4 table
│   │   ├── confidence.ts               # scoring + tiers — blocked on §3 Tier-1 sign-off
│   │   ├── proposeRule.ts
│   │   └── index.ts
│   │
│   ├── db/                             # not named in §5, but repositories need a shared home
│   │   ├── pool.ts                     # pg.Pool singleton
│   │   ├── migrate.ts                  # programmatic node-pg-migrate runner, called on boot
│   │   ├── schema.types.ts             # zod row schemas + z.infer types, mirrors DDL exactly
│   │   ├── errors.ts
│   │   └── repositories/
│   │       ├── torrentsRepo.ts         # upsert (snapshots raw_name ONCE), markGone, list
│   │       ├── filesRepo.ts            # upsert by (torrent_hash, torbox_file_id), setMountPath
│   │       ├── titlesRepo.ts           # findOrCreate by provider id — see §3.5
│   │       ├── rulesRepo.ts            # upsert by (torrent_hash, season), queue query
│   │       ├── mappingsRepo.ts         # replaceForRule(ruleId, rows), rebuildAll()
│   │       ├── providerCacheRepo.ts    # provider_seasons reads/writes — see §3.2
│   │       ├── playLogRepo.ts
│   │       └── index.ts
│   │
│   ├── torbox/                         # §5.1
│   │   ├── client.ts                   # mylist, per-torrent ?id=, requestdl, webdav refresh
│   │   ├── envelope.ts                 # checks {success} before touching {data}
│   │   ├── schemas.ts                  # zod: list-with-files / list-without-files / single-by-id
│   │   ├── rateLimit.ts                # configurable concurrency/delay — see §3 Tier 2
│   │   └── index.ts
│   │
│   ├── metadata/                       # §5.4
│   │   ├── types.ts                    # TitleCandidate, SeasonEpisodeCount, ProviderGap
│   │   ├── tmdb.ts                     # ships first — see §3 Tier 2
│   │   ├── tvdb.ts                     # fast-follow; login/JWT/refresh state machine
│   │   ├── cache.ts                    # wraps tmdb/tvdb, reads/writes provider_seasons
│   │   ├── searchTitles.ts             # searchTitles(query, lang) for the show picker
│   │   └── index.ts
│   │
│   ├── ingest/                         # §5.2 — orchestration: torbox + db + resolve + metadata
│   │   ├── pipeline.ts                 # the 7-step sequence, one function per step
│   │   ├── scheduler.ts                # node-cron
│   │   ├── mountDiscovery.ts           # optional; collision policy per §3 Tier 2
│   │   ├── notify.ts                   # webhook POST — the whole n8n boundary per §8
│   │   └── index.ts
│   │
│   ├── http/                           # §5.5 + §5.6 host process
│   │   ├── server.ts                   # build(): Fastify instance, not started (reused by tests)
│   │   ├── hooks/
│   │   │   ├── verifyAddonToken.ts     # constant-time compare vs ADDON_TOKEN
│   │   │   └── verifyBasicAuth.ts      # ADMIN_USER/ADMIN_PASS — see §4 table
│   │   ├── routes/
│   │   │   ├── addon/
│   │   │   │   ├── index.ts            # registers under '/:token' + verifyAddonToken
│   │   │   │   ├── manifest.ts         # types: ["series"] — see §2
│   │   │   │   ├── stream.ts
│   │   │   │   └── play.ts             # requestdl -> 302 + play_log insert
│   │   │   └── admin/
│   │   │       ├── index.ts            # single auth-hooked scope; nests /admin (spa) + /api (json)
│   │   │       ├── ingestRoutes.ts     # POST /api/ingest/run
│   │   │       ├── queueRoutes.ts / rulesRoutes.ts / libraryRoutes.ts / healthRoutes.ts
│   │   │       ├── titlesRoutes.ts     # GET /api/titles/search -> metadata.searchTitles
│   │   │       └── spaRoutes.ts        # static assets + SPA fallback
│   │   ├── streamMapper.ts             # builds Stream objects, notWebReady logic
│   │   └── index.ts
│   │
│   └── ui/                             # §5.6 — separate workspace, Vite/React SPA
│       ├── package.json / vite.config.ts / tsconfig.json / index.html
│       ├── public/fonts/               # self-hosted JetBrains Mono + Inter, not CDN
│       └── src/
│           ├── main.tsx / App.tsx
│           ├── routes/
│           │   ├── QueuePage.tsx       # j/k/Enter/a keyboard nav
│           │   ├── LabellerPage.tsx    # two-pane layout, owns PreviewTable wiring
│           │   ├── LibraryPage.tsx
│           │   └── HealthPage.tsx
│           ├── components/
│           │   ├── MonoText.tsx        # enforces JetBrains Mono for all filename rendering
│           │   ├── HomoglyphInspector.tsx  # imports normalize/homoglyphMap directly (runtime)
│           │   ├── PreviewTable.tsx    # imports resolve/expandRule directly — see §4 table
│           │   ├── ShowPicker.tsx / ConfidenceBadge.tsx / ValidationBanner.tsx / EpisodeGrid.tsx
│           ├── hooks/useKeyboardNav.ts
│           ├── api/client.ts / queries.ts   # TanStack Query
│           └── styles/tokens.css / global.css  # dark low-chroma, 2 accents, prefers-reduced-motion
│
└── test/
    ├── fixtures/
    │   ├── torrents/sokrovishcha-imperatora.json   # §1 ex.1 — 8-из-13 case
    │   ├── torrents/stavka-na-lyubov.json           # §1 ex.2 — 10-из-10 case
    │   ├── torrents/bolshoy-kush.json               # §1 ex.3 — homoglyph + absolute_hint case
    │   └── index.ts                     # typed fixture loader
    ├── normalize/normalise.test.ts      # incl. the 1080p / 1080р (U+0440) pair by name
    ├── extract/
    │   ├── xOfY.test.ts                 # incl. "01-16 из 16" range form
    │   ├── seasonEpisode.test.ts        # s02.E04 separator variants
    │   ├── naturalSort.test.ts          # 1,2,10 vs 1,10,2
    │   └── cascade.test.ts              # leading number never overrides explicit SxxExx
    ├── resolve/
    │   ├── expandRule.test.ts           # §7 pathological cases verbatim (sort, continuous
    │   │                                 # across a season boundary, trailer/'ignore', count-
    │   │                                 # vs-X-из-Y mismatch)
    │   └── confidence.test.ts           # blocked on §3 Tier-1 sign-off (3.3/3.4)
    ├── torbox/envelope.test.ts          # success:false; both mylist shapes (array vs ?id= object)
    ├── db/repositories/*.test.ts        # testcontainers-backed, real Postgres 16
    └── http/
        ├── addon.test.ts                # manifest shape, token auth valid/invalid/missing
        └── basicAuth.test.ts            # /api/ingest/run specifically — no unauthenticated route
```

Two things deliberately left out: no `src/shared/` (the UI reaches `normalize`/`extract`/
`resolve/expandRule`+`numbering` as real runtime imports since they're genuinely dependency-free,
and everything else as `import type` which erases at build time — a shared re-export layer
would be pure ceremony at this size); no `/api/rules/preview` route (superseded by client-side
`expandRule`, §4 table).

---

## 6. What happens next

Once you've weighed in (doesn't need to be all of §3 at once — Tier 1 items 3.1/3.2 are the
only ones that actually block starting), I begin **Milestone 1** exactly as locked: TorBox
client + zod schemas, migrations, Docker Compose up on ARM64, `mylist` → Postgres with
snapshots — no matching, no UI. Verification is the build order itself: Milestone 1 is done
when `docker compose up` produces real rows in `torrents`/`files` on the actual Oracle Cloud
ARM64 box; Milestone 2 when two hand-written SQL rules produce correct output from
`expandRule`'s unit tests; Milestone 3 when a `.ts` and an `.mp4` actually play from inside
real Stremio and AIOStreams installs.

Two things I'll need from you before Milestone 1 can run against real data (not blockers to
starting the scaffolding, but blockers to a real ingest run): a `TORBOX_API_KEY`, and confirmed
access to the Oracle Cloud ARM64 host for the actual `docker compose up`. TMDB/TVDB keys aren't
needed until Milestone 4/5.

*(Milestone 1 has since shipped against a real local Postgres, with the deviations noted in the
status callout at the top of this document. The TorBox-facing code is still unverified against
a live account — see `README.md`.)*
