# Milestone 5 plan: the auto-proposal engine

> Status: proposed, not started. Written against `dev` at commit `34ced0e` (Milestones 1-4 done
> and merged; Milestone 4's Health screen already covers part of Milestone 6). Per the locked
> build order (`torbox-ru-addon-spec.md` §6), this is the next and last major piece of new
> domain logic — Milestone 6 is scheduling/notifications on top of what already exists.

## Why this is the hard part, and why it's last

Everything shipped so far (ingest, `expandRule`, the addon routes, the Labeller UI) either
avoided parsing entirely (Milestones 1-3: hand-written SQL rules, manual numbering modes) or
deferred it to a human (Milestone 4: the Labeller's `sequential`/`continuous`/`manual` modes are
all "don't parse, just count/override"). Milestone 5 is where the system starts _reading_
torrent names and filenames automatically — homoglyph normalisation, token masking, the
5-stage extractor cascade, and confidence scoring — the actual hard part the spec's intro names
as "the whole project" (§3). The build order put it last on purpose: `expandRule` and real
playback had to be proven against a stable schema first, because "the data model is free to
change until [Milestone 3] and expensive to change after" (§6).

**The failure mode this milestone exists to avoid, quoted directly from the spec (§9):** "a
plausible-but-wrong mapping... looks like it worked." A parser that's _confident_ and _wrong_ is
explicitly worse than one that's honestly uncertain and queues for review. Every design choice
below is in service of that — cross-validation over pattern-matching cleverness, a hard floor
that withholds auto-commit regardless of score, and an explanation string surfaced in the UI
rather than a bare number.

## What already exists vs. what this milestone builds

| Piece                                                                                | State                                                                                                                                                               | Where                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `expandRule`, `sequential`/`continuous`/`manual` numbering                           | Shipped, tested (Milestone 2)                                                                                                                                       | `src/resolve/{expandRule,numbering}.ts`       |
| `numbering: 'parsed'`                                                                | Stubbed — throws by design                                                                                                                                          | `src/resolve/numbering.ts`'s `expandParsed`   |
| `src/normalize/` (homoglyph folding)                                                 | **Does not exist**                                                                                                                                                  | —                                             |
| `src/extract/`                                                                       | Only `naturalSort.ts` (pulled forward into Milestone 2 for `sort: 'natural'`)                                                                                       | `src/extract/`                                |
| `src/resolve/confidence.ts`, `proposeRule.ts`                                        | **Do not exist**                                                                                                                                                    | —                                             |
| `provider_seasons` cache (title_id, season, source, episode_count, episodes jsonb)   | Shipped (Milestone 4)                                                                                                                                               | `src/db/repositories/providerSeasonsRepo.ts`  |
| TMDB client: `searchTitles`, `fetchExternalIds`, `fetchSeasonDetails`                | Shipped (Milestone 4)                                                                                                                                               | `src/metadata/tmdb.ts`                        |
| TVDB client                                                                          | **Does not exist** — Tier-2 fast-follow, not blocking                                                                                                               | —                                             |
| Ingest pipeline's "propose rules for unruled torrents" step (spec §5.2, step 5 of 7) | **Does not exist** — pipeline currently only rebuilds mappings for rules that already exist                                                                         | `src/ingest/pipeline.ts`                      |
| Queue's proposed-title/season/confidence                                             | A regex placeholder (`why: 'Proposal engine not built yet (Milestone 5)'`, confidence hardcoded `0.1`)                                                              | `src/http/routes/api/index.ts`'s `GET /queue` |
| Labeller's `numbering` dropdown                                                      | `parsed` rendered but `disabled`                                                                                                                                    | `ui/src/App.tsx`                              |
| `X из Y` detection                                                                   | Exists **client-side only**, as a UI display heuristic (`parseXizY` in `ui/src/App.tsx`) — not the real server-side signal the spec's confidence table (§5.3) means | `ui/src/App.tsx`                              |
| `test/fixtures/`                                                                     | **Does not exist**                                                                                                                                                  | —                                             |

So this milestone is genuinely greenfield for `normalize/` and most of `extract/`, but it isn't
starting from nothing: the pure/infra/orchestration split, the `Rule`/`Mapping` types, the
`provider_seasons` cache, and the TMDB client it needs to call are all already in place and
don't need to change shape.

## Blocking sign-offs before implementation starts

`torbox-ru-addon-plan.md` §3 (Tier 1) flagged four items as needing the repo owner's explicit
confirmation before Milestone 5, and `docs/decisions.md` still lists them **PENDING**. Two are
already moot (resolved by what shipped); two are the real gate:

1. **Numbering-mode semantics (plan.md §3.1) — de facto resolved.** `sequential`/`continuous`/
   `manual` shipped exactly as proposed there and have been in production use since Milestone 2.
   Nothing to re-litigate; only `parsed`'s own cascade (§3.5) is new work.
2. **`provider_seasons` schema addition (§3.2) — de facto resolved.** Implemented and in active
   use since Milestone 4 (TMDB season caching in `POST /api/rules`). Nothing to re-litigate.
3. **Confidence materialisation: the three-way split (§3.3) — ✅ confirmed.** High → insert
   rule + `rebuildMappings` immediately (live, no flag); medium → insert + `rebuildMappings` but
   flag `⚠` in the stream description; positional-fallback-only → insert the rule but **withhold**
   `rebuildMappings` (inert — shows in Queue, produces zero streams until a human accepts it).
   The positional-fallback-only tier is a **cascade-stage gate**, not a score floor: it fires
   when stage 5 (positional/natural-sort fallback) was the only cascade stage that matched,
   regardless of the final score. See `docs/decisions.md` §"Milestone 5 pre-implementation
   sign-offs".
4. **The confidence formula itself (§3.4) — ✅ confirmed (shape locked; thresholds tuned during
   implementation).** Weighted signal sum, normalised over _applicable_ signals only; positional
   floor evaluated categorically first; HIGH requires score ≥ 0.75 **and** at least one
   high-weight signal fired; MEDIUM requires score ≥ 0.45 (and not positional-floor). Full signal
   weight table in `docs/decisions.md` §"Milestone 5 pre-implementation sign-offs".

**Both gate items confirmed.** Step 4 (`src/resolve/confidence.ts`) is unblocked; steps 1–3 can
proceed in parallel.

## Detailed build plan

### Step 1 — `src/normalize/` (spec §3.1)

```
src/normalize/
  homoglyphMap.ts   # confusables table
  normalise.ts       # normalise(s): fold, collapse whitespace, lowercase
  index.ts
```

- `normalise()`: the one-directional (Cyrillic→Latin) fold from the spec's table, applied before
  _any_ pattern match touches a string — every `extract/` module takes normalised input, never
  raw. Fold `ё→е` too, collapse whitespace, lowercase. **Never mutate the display string** —
  every place that already shows `raw_name_at_ingest`/`raw_path` to the user (Queue, Labeller,
  Library — all already rendering through `highlightHomoglyphs` in `ui/src/App.tsx`) keeps doing
  so untouched; `normalise()` output is for matching only.
- `homoglyphMap.ts`: plan.md's Tier-2 note applies — build the confusables table
  **bidirectionally** even though `normalise()` itself only ever folds one way. The existing UI
  homoglyph inspector (`highlightHomoglyphs`, shipped in Milestone 4) currently uses an ad hoc
  majority-script heuristic (Latin/Cyrillic character-code ranges) rather than a real confusables
  table — worth deciding here whether to swap it to import this module directly (dependency-free,
  same pattern already established for `resolve/expandRule`+`types` being imported straight into
  `ui/src/App.tsx`) or leave the two independent. Recommend swapping: one source of truth for
  "which characters are confusable," and the UI gets the real bidirectional table for free
  instead of a heuristic.
- Tests: `test/normalize/normalise.test.ts`, explicitly covering the `1080p`/`1080р` (U+0440)
  pair by name per spec §7, plus a handful of other confusable-letter cases from the table.

### Step 2 — `src/extract/` (spec §3.2-3.5)

```
src/extract/
  types.ts
  vocabulary.ts        # серия|серии|серию|выпуск|выпуска|выпуски|эпизод|эп.|часть, §3.3
  maskTokens.ts         # ordered masking pipeline, §3.2
  qualityCodecTokens.ts # quality/codec/release-group lists, configurable
  airDate.ts            # "Эфир от DD.MM.YYYY", §3.2 stage 1
  xOfY.ts               # §3.4 LOCKED: X из Y is a completeness count, not an episode
  seasonEpisode.ts       # cascade stage 1: SxxExx, incl. s02.E04 separator variants
  episodeNumber.ts       # cascade stage 2: number+word / word+number
  naturalSort.ts         # already exists, unchanged
  cascade.ts             # 5-stage priority orchestration, §3.5 LOCKED
  index.ts
```

Build order within this step, each with fixture/unit tests before moving on (this is the part
of the system the spec calls out as needing exhaustive testing, §7):

1. **`vocabulary.ts`** — regex builder over the episode-word vocabulary (§3.3). Trivial, but
   everything downstream depends on getting the word list right.
2. **`maskTokens.ts`** + **`qualityCodecTokens.ts`** — the ordered masking pipeline (§3.2): air
   dates → years → quality/codec tokens → release groups → season/episode markers, _then_ bare
   numbers. Order is load-bearing — masking quality tokens before season/episode markers is why
   `1080p` never gets mistaken for an episode number, but season/episode markers still have to
   be captured (not just masked blank) since stage 1 of the cascade needs them.
3. **`airDate.ts`** — `Эфир от DD.MM.YYYY` extraction. Feeds both the masking pipeline (stage 1)
   and the cascade's own stage 3 (air-date → episode lookup against `provider_seasons.episodes`,
   which already stores `{episode, air_date}` pairs — this is the first real consumer of that
   jsonb column beyond raw storage).
4. **`xOfY.ts`** — **LOCKED**: `X из Y` (and the `A-B из Y` range form, `X = B - A + 1`) is a
   validation signal, never an episode number. This is a completely separate code path from the
   cascade — it doesn't produce an episode number for any file, it produces `{present, total}`
   for `proposeRule`'s confidence scoring and the Labeller's validation banner. Note: the UI
   already has a client-side `parseXizY` doing a subset of this for display (Milestone 4) — this
   module is the real, tested, server-side version `proposeRule` actually scores against;
   whether to also swap the UI's copy to import this module directly (same dependency-free
   pattern as `expandRule`) is a small follow-up decision, not blocking.
5. **`seasonEpisode.ts`** — cascade stage 1, `SxxExx` with flexible separators (`s02.E04`,
   `S02E04`, `s02_e04`, etc. — the spec's own example `s02.E04` is the one concrete case named).
6. **`episodeNumber.ts`** — cascade stage 2, `(\d{1,3})\s*(vocabulary word)` and the reversed
   form.
7. **`cascade.ts`** — orchestrates all five stages in priority order, **first match wins**:
   `seasonEpisode` → `episodeNumber` → air-date lookup → leading bare number after masking →
   positional (natural-sort, index → episode). Two invariants this module alone is responsible
   for enforcing, both **LOCKED**:
   - A leading bare number is captured as `absolute_hint` (a cross-check signal), **never**
     substituted for an explicit `SxxExx` match, even when they disagree — the spec's own
     Bolshoy Kush example (`14.` is absolute episode 14, `s02.E02` is the aired-order truth;
     the cascade must return `S02E02`, using `14` only as a signal that feeds `continuous`
     mode's arithmetic and confidence scoring, never as the primary answer).
   - Single-file torrents (§3.6): parse the **torrent name**, ignore the filename entirely. This
     has to be checked before dispatching per-file, not handled as a cascade stage — it changes
     _which string_ every stage below it reads.

Tests: one fixture-driven test file per stage (`xOfY.test.ts` including the range form,
`seasonEpisode.test.ts` covering separator variants, `naturalSort.test.ts` already exists,
`cascade.test.ts` asserting the leading-number-never-overrides-SxxExx invariant by name), all
built against `test/fixtures/` (see below) rather than inline strings, so the real spec §1
examples are what's actually exercised.

### Step 3 — `test/fixtures/`

```
test/fixtures/
  torrents/sokrovishcha-imperatora.json   # §1 ex. 1 — 8-из-13, reality show, "выпуск" vocabulary
  torrents/stavka-na-lyubov.json           # §1 ex. 2 — 10-из-10, exact match case
  torrents/bolshoy-kush.json               # §1 ex. 3 — homoglyph + absolute_hint case
  index.ts                                  # typed fixture loader
```

Real torrent names and file lists, not invented ones — spec §7 is explicit about this ("Do not
test against live TorBox. Record fixtures.") and these three are the exact examples the spec
itself gives in §1, so every extractor stage and `proposeRule` test can point at the same three
real, messy, already-scrutinised inputs instead of each test file inventing its own strings.

### Step 4 — `src/resolve/confidence.ts` + `proposeRule.ts` (spec §5.3)

(Sign-offs 3/4 confirmed — this step is unblocked. See `docs/decisions.md` §"Milestone 5
pre-implementation sign-offs".)

```
src/resolve/
  confidence.ts   # scoring + tier assignment
  proposeRule.ts  # proposeRule(torrent, files, titleCandidates): RuleProposal
```

- `confidence.ts` implements the signal table (§5.3) — file count vs. `X из Y`, file count vs.
  `provider_seasons.episode_count`, every file yielding an explicit `SxxExx`, `absolute_hint`
  consistency, air-date alignment, positional-fallback-used — each weighted high/medium/low per
  the spec, combined per whatever formula gets signed off in item 4 above. Pure, no I/O, testable
  with the same fixture set as the cascade.
- `proposeRule.ts` is the one function in this module that isn't pure — it needs
  `provider_seasons` (already cached) and `titleCandidates` (title matching/search) as inputs,
  but doesn't itself call TMDB live; whatever calls it is responsible for having already resolved
  or cached what it needs. Returns a rule proposal **plus a human-readable explanation** (the
  `why` string the Queue already has a placeholder field for) — see the open question below on
  where that explanation lives.
- `numbering.ts`'s `expandParsed` gets wired to the real cascade here, replacing its current
  "throws by design" stub. This is the one existing file this milestone actually _changes_
  rather than just adding alongside.

**Resolved: option (a) confirmed.** A new nullable `rules.proposal_reason text` column will be
added via an additive migration (no existing columns touched). This is an immutable snapshot of
the evidence present at proposal time — consistent with how `raw_name_at_ingest` is treated
elsewhere, and avoids silent drift if `provider_seasons` is refreshed after the proposal is made.
See `docs/decisions.md` §"Milestone 5 pre-implementation sign-offs".

### Step 5 — Wire into the ingest pipeline (spec §5.2, step 5 of 7)

`src/ingest/pipeline.ts`'s `runIngest()` currently jumps straight from "mark absent gone" to
"rebuild mappings for existing rules," skipping the spec's step 5 entirely (its own comment
says so explicitly). This milestone adds it back in between:

```
refresh webdav → fetch mylist → upsert torrents → fetch files → mark absent gone
  → propose rules for unruled torrents      # NEW — this milestone
  → rebuild mappings                         # existing, now also covers newly-proposed rules
  → notify if anything needs review          # still Milestone 6 (webhook boundary, §8)
```

"Unruled torrents" = active torrents with no existing `rules` row — the same set `GET /api/queue`
already selects (`where t.status = 'active' and r.id is null`). For each, run `proposeRule`
against its files and a title match (search by cleaned-up torrent name against TMDB, reusing
`searchTitles`), then `upsertRule` with the result. Per the sign-off in step 4/item 3: high and
medium confidence also trigger `rebuildMappingsForRule` immediately (medium still flagged `⚠`
downstream via the stream description, which already reads `rules.confidence` for exactly this);
positional-fallback-only inserts the rule but does **not** rebuild — it shows up in the Queue as
before, just now backed by a real proposal instead of the placeholder regex.

Title matching itself (torrent name → title candidate) is the one piece of glue not fully
specified anywhere above — needs a strategy (search TMDB by the cleaned torrent name, take the
top result above some similarity bar, else leave `titleId` unset and force manual review through
the Queue same as today). Worth scoping tightly: this doesn't need to be good, just needs to
correctly _decline_ to guess when it's not confident, consistent with the whole milestone's
governing principle.

### Step 6 — Replace the Queue/Labeller placeholders

- `GET /api/queue` (`src/http/routes/api/index.ts`): swap the regex placeholder (`proposedTitle`/
  `proposedSeason`/hardcoded `0.1` confidence/static `why` string) for reading the real
  `rules`/`proposal_reason` row now populated by step 5, for torrents that got a proposal but
  are still awaiting acceptance (i.e. `source = 'auto'` rows below the auto-commit tier).
- `ui/src/App.tsx`'s Labeller: enable the `parsed` option in the numbering-mode `<select>` (it's
  rendered `disabled` today specifically because of this gap) and pre-fill the form from the
  `proposeRule` output the same way it already pre-fills from an existing rule when editing
  (Milestone 4 follow-up) — pick reasonable defaults (season, numbering mode) from the proposal
  rather than the current torrent-name regex guess.
- The Labeller's validation banners (`xizY`/`fileCountWarning`, already shipped) start reflecting
  real backend-validated data once `xOfY.ts`/`confidence.ts` exist server-side, rather than only
  the client-side `parseXizY` heuristic.

### Step 7 — Verify, then update docs

1. `npm run typecheck && npm run lint && npm test` — full suite green, new fixture-driven tests
   included.
2. Run a real ingest against the repo owner's actual TorBox account (already proven reachable
   and populated — 210 torrents, 2067 files, per Milestone 1's verification) and inspect what
   `proposeRule` actually produces for real, messy, previously-unseen torrents beyond the three
   spec examples — this is the real test of whether the confidence tiers behave sanely at scale,
   not just against three hand-picked fixtures.
3. Spot-check: does anything auto-commit that shouldn't have? Does anything queue that should
   have auto-committed? Both directions matter — over-cautious is annoying, over-confident is
   the named failure mode.
4. Update `docs/decisions.md` (resolve the PENDING sign-off items with what was actually
   confirmed, record the real formula/thresholds landed on) and `docs/milestones.md` (Milestone 5
   → done) once verified.

## Explicitly out of scope for this milestone

- **TVDB** (`src/metadata/tvdb.ts`) — plan.md Tier 2: real asymmetric complexity (login → JWT →
  refresh state machine) vs. TMDB's static bearer key, and TMDB already covers Russian fields and
  episode/air-date data. Fast-follow once the pipeline's proven on TMDB alone, unless a specific
  show is found where TMDB has a real coverage gap.
- **Mount discovery** (`TORBOX_MOUNT_PATH`, populating `files.mount_path`) — optional, off the
  streaming critical path entirely (spec §5.2), not scheduled in any milestone including this one.
- **Milestone 6 proper** — `node-cron` scheduling (wiring `runIngest` to run on a timer instead
  of manually/on-demand) and the webhook notification boundary (§8). This milestone's pipeline
  change (step 5) makes automatic proposals possible; actually running ingest unattended is still
  Milestone 6.
- **Deleting a rule/mapping for a gone torrent** — an existing known gap (see `docs/decisions.md`,
  `docs/milestones.md` §6), unrelated to auto-proposal and not blocking it.
