# RuTracker feed scraper implementation plan

> Status: implemented as written, including every fix from the review pass (reuse
> `parseTorrent()`, the upsert-on-conflict fix, word-boundary matching, feed-fetch failure
> isolation, `bigint` topic_id, paired down migration, `GET /api/feed` pagination). Verified
> against a real Postgres 16 instance and the real live `f/939` feed (saved as
> `test/fixtures/rutracker-f939.xml`, 50 entries, 5 of them the "Большой куш. Бангкок" season-2
> episodes) — `npm run typecheck && npm run lint && npm test` all green (24 files, 151 tests).
> Not yet exercised against a real deployed instance/TorBox account; that's the one piece left
> per the plan's own manual-verification section.

## What this is

A new `src/rutracker/` module that polls `https://feed.rutracker.cc/atom/f/939.atom`
(and optionally other forum feeds) on every ingest run, matches entries against the titles
already in the `titles` table, and records new/updated entries in a purpose-built
`feed_entries` table. On a match, a lightweight notification is logged (and later — in
Milestone 6 — pushed via the webhook boundary the spec already defines). This is entirely
additive: no existing tables or pipeline steps change shape.

### The feed — what it gives us

Each `<entry>` in the Atom feed carries:
- **`<id>`** — `tag:rto.feed,YYYY-MM-DD:/t/<topicId>` — the RuTracker topic ID is the
  stable key
- **`<link href>`** — `https://rutracker.org/forum/viewtopic.php?t=<topicId>`
- **`<title>`** — the torrent's full Russian title string (exactly the kind the
  `src/normalize/` + `src/extract/` pipeline already knows how to read)
- **`<updated>`** — RFC 3339 timestamp — changes when the torrent is updated with new
  episodes (`[Обновлено]` prefix in title)

The title string is the _same_ format as `torrents.raw_name_at_ingest`, so the existing
extractor cascade (`src/extract/cascade.ts`) can parse it directly — no new parsing logic
needed. This scraper's matching step uses `parseTorrent()` for title-cleaning and season,
then `normalise()` for the actual comparison; it does not need per-episode extraction
(`parseEpisodeSource`/the full cascade) since matching is by show name, not episode.

### What "in my library" means

A feed entry matches the library if the **normalised** title prefix of the feed entry
matches the `normalise(name_ru)` or `normalise(name_en)` of any `titles` row. The same
homoglyph-folding + token-masking the extractor cascade uses ensures that
`Большой куш. Бангкок` matches `Большой Куш` (which is `titles.name_ru` for that show).

---

## Proposed changes

### New: `src/rutracker/` module

```
src/rutracker/
  feedEntry.ts       # Zod schema + type for a parsed Atom entry
  fetchFeed.ts       # HTTP GET + XML → FeedEntry[]
  matchEntries.ts    # FeedEntry[] × TitleRow[] → MatchedEntry[]
  index.ts           # re-exports
```

#### [NEW] `feedEntry.ts`
Zod schema for the fields we need:
```ts
export const feedEntrySchema = z.object({
  topicId: z.number().int(),        // extracted from <id> tag
  url: z.string().url(),            // <link href>
  rawTitle: z.string(),             // <title> text content
  updatedAt: z.date(),              // <updated> parsed
});
export type FeedEntry = z.infer<typeof feedEntrySchema>;
```

#### [NEW] `fetchFeed.ts`
- Uses the built-in `fetch` (Node 18+) — no new dependencies for the HTTP layer.
- Parses XML with `fast-xml-parser` (pure JS/TS, no native bindings, no `DOMParser`
  polyfill required — confirmed as the library choice).
- Returns `FeedEntry[]`, validated through the schema. Any malformed entry is logged and
  skipped — the same "log and skip" pattern the TorBox client uses for envelope failures.
- Hard-codes the one forum URL as a default; `RUTRACKER_FEED_URLS` env var (optional,
  comma-separated) overrides it so additional forums can be added without a code change.
- **Network/parse failures are caught inside `fetchFeed()` itself, per URL, and never
  thrown to the caller.** A failed GET or a feed that doesn't parse as XML at all is
  logged with `logger.warn` and treated as zero entries for that URL — the same
  soft-fail posture `pipeline.ts` already uses for `refreshWebdav()` (a `false` return,
  not a throw). RuTracker being unreachable must not take down the rest of the ingest
  run (torrent upsert, mapping rebuild); the feed step is purely additive and optional.

#### [NEW] `matchEntries.ts`
- `matchEntries(entries: FeedEntry[], titles: TitleRow[]): MatchedEntry[]`
- For each entry: call `parseTorrent(entry.rawTitle)` from `src/extract/cascade.ts` — **do
  not** reimplement `[Обновлено]`/bracket stripping or season parsing here. Feed entry
  titles are the same string format as `torrents.raw_name_at_ingest`, and `parseTorrent`
  already strips brackets, extracts `season` via its `seasonRegex`, and returns
  `cleanedTitle` — exactly what `resolveTitleMatch` in `src/ingest/pipeline.ts` already
  does for torrent names. Reusing it here means the two title-cleaning paths (ingest
  matching and feed matching) can never silently drift apart; a fix to `parseTorrent`'s
  stripping rules benefits both call sites for free. Normalise the resulting
  `cleanedTitle` with `normalise()`.
- For each title: normalise `name_ru` (and `name_en` if set), plus each alias.
- Match = a normalised entry prefix **starts with** or **contains** any normalised title
  string, **at a token boundary** — the match must begin at the start of the entry prefix
  or immediately follow whitespace, and must end at the end of the prefix or immediately
  precede whitespace. Plain substring containment is not enough: a title normalised to
  `дом` must not match inside `домработница`. This still handles the season-suffix case
  (entry prefix ⊇ title name, not the reverse) — `Большой куш. Бангкок 2 сезон` matches
  `Большой Куш` because `куш` is followed by `.` which we also treat as a boundary — while
  refusing to match a title name that's merely a substring of a longer word.
- Returns `{ entry, title, season? }` — `season` comes directly from `parseTorrent`'s
  return value, not a separate best-effort parse.
- No fuzzy matching, no Levenshtein — exact normalised, boundary-checked substring only.
  If it doesn't match, it doesn't match. False negatives are acceptable; false positives
  are not.

---

### New: `feed_entries` table (additive migration)

```sql
CREATE TABLE feed_entries (
  topic_id      bigint        PRIMARY KEY,  -- RuTracker topic ID
  title_id      uuid          REFERENCES titles(id) ON DELETE SET NULL,
  raw_title     text          NOT NULL,
  url           text          NOT NULL,
  first_seen    timestamptz   NOT NULL DEFAULT now(),
  last_updated  timestamptz   NOT NULL,     -- from <updated>
  notified_at   timestamptz               -- NULL = pending notification
);
CREATE INDEX feed_entries_title_id_idx ON feed_entries(title_id);
CREATE INDEX feed_entries_notified_at_idx ON feed_entries(notified_at) WHERE notified_at IS NULL;
```

Paired with a `down` migration (`DROP TABLE IF EXISTS feed_entries;`), matching the
`up`/`down` convention every existing migration in `migrations/` follows.

**Key design decisions:**
- `topic_id` (not a surrogate uuid) is the PK — the RuTracker topic is the stable
  external key. `bigint` rather than `integer`: RuTracker's current topic IDs fit
  comfortably in `integer`, but there's no cost to removing the ceiling now versus a
  migration later.
- `ON CONFLICT (topic_id) DO UPDATE SET title_id = excluded.title_id, raw_title =
  excluded.raw_title, last_updated = excluded.last_updated` — **updates `title_id` and
  `raw_title`, not just `last_updated`.** This matters because unmatched entries are
  only stored at all when `RUTRACKER_STORE_UNMATCHED=true`, with `title_id = NULL`; if
  a matching title is added to the library later (a new show gets labelled) and the
  same topic reappears in a later feed poll, the row must pick up the new `title_id` on
  that upsert. Updating only `last_updated` would leave it `NULL` forever even after a
  real match exists. `raw_title` is refreshed too since `[Обновлено]` changes the title
  string itself.
- `title_id` is nullable (SET NULL on cascade) — only matched entries are stored by
  default (see open questions below).
- `notified_at` is the webhook-readiness flag: `NULL` = "saw this entry, hasn't
  notified yet"; non-null = "notification was sent at this timestamp." Milestone 6
  drives it; this milestone just writes rows with `NULL`.

#### [NEW] `src/db/repositories/feedEntriesRepo.ts`
- `upsertFeedEntry(input): Promise<FeedEntryRow>` — `ON CONFLICT (topic_id) DO UPDATE`
- `listUnnotifiedEntries(): Promise<FeedEntryRow[]>` — for Milestone 6
- `markNotified(topicIds: number[]): Promise<void>` — for Milestone 6
- `schema.types.ts` gets `feedEntryRowSchema` + `FeedEntryRow` added

---

### Modified: `src/ingest/pipeline.ts`

A new step inserted between "mark absent gone" and the auto-proposal step (Milestone 5's
"propose rules for unruled torrents" has since shipped and is already live in
`pipeline.ts` — the diagram below reflects the pipeline as it exists today, not the
pre-Milestone-5 state the original version of this plan was written against):

```
refresh webdav → fetch mylist → upsert torrents → fetch files → mark absent gone
  → poll feed + match against library + upsert feed_entries   # NEW — this plan
  → propose rules for unruled torrents                         # existing (Milestone 5)
  → rebuild mappings                                           # existing
  → notify if anything needs review                           # Milestone 6
```

The step:
1. Fetches all `titles` rows from `titlesRepo.listAll()` (a new read, cheap — the table
   is small)
2. Calls `fetchFeed()` and `matchEntries()` — `fetchFeed()` never throws (see above); a
   failed poll just yields zero entries and a logged warning, so the rest of the run
   (including the proposal step immediately after) proceeds unaffected
3. Upserts every matched entry into `feed_entries` via `feedEntriesRepo.upsertFeedEntry`
4. Logs a summary: `{ feedEntriesSeen, feedEntriesMatched, feedEntriesNew }`

Unmatched entries (no title found) are **not stored** by default — only matched entries
go into `feed_entries`. This keeps the table clean and avoids it growing unboundedly.
An opt-in `RUTRACKER_STORE_UNMATCHED=true` env flag stores everything for debugging.

`IngestSummary` gains two new fields: `feedEntriesMatched: number`,
`feedEntriesNew: number`.

---

### Modified: `src/config.ts`

Two new optional env vars (added under the Milestone 4 section comment):
```ts
RUTRACKER_FEED_URLS: z.string().optional()
// comma-separated list of Atom feed URLs; defaults to https://feed.rutracker.cc/atom/f/939.atom
RUTRACKER_STORE_UNMATCHED: z.coerce.boolean().default(false)
// whether to persist non-matched feed entries (for debugging)
```

No default for `RUTRACKER_FEED_URLS` forces the consumer to fall back to the hardcoded
constant inside `fetchFeed.ts` — the same pattern as `NOT_WEB_READY_EXTENSIONS`.

---

### New: admin API route `GET /api/feed`

A new read-only route under the existing `/api` prefix (same Basic Auth as all `/api`
routes):

- `GET /api/feed?limit=&offset=` — returns `feed_entries` rows (newest `last_updated`
  first), with `title_id` joined to `titles.name_ru`. `limit` defaults to 50, capped at
  200 (same bound pattern as `GET /api/health`'s `recentPlays limit 50`); `offset`
  defaults to 0. Useful for the Health/Library views to show "new episodes seen in feed
  since last ingest."

No write routes — the scraper owns all writes to this table. The Labeller doesn't need
to interact with it.

---

## Open questions — confirmed answers

**XML parsing library:** `fast-xml-parser` confirmed — pure JS/TS, tree-shakes well,
no `DOMParser` polyfill needed. One new `devDependency` (build-time) and one
`dependency` for the runtime bundle.

**Unmatched entries:** Store only matched entries by default (confirmed). `title_id = NULL`
rows are not written unless `RUTRACKER_STORE_UNMATCHED=true` is set. Keeps the table
library-scoped and bounded.

**Multiple feed URLs:** `RUTRACKER_FEED_URLS` env var (comma-separated) is the right
extensibility point. f/939 is the only forum hardcoded; others can be added at runtime.

---

## Dependency on Milestone 5 — resolved

This plan originally gated on Milestone 5 Step 1 (`src/normalize/`) shipping first, with
a fallback shim `normalise()` in case the feed scraper landed earlier. Milestone 5 has
since shipped in full: `src/normalize/normalise.ts`, `src/extract/cascade.ts`
(`parseTorrent`), `src/resolve/`, and the auto-proposal pipeline step are all real,
merged code. `matchEntries.ts` should import `normalise()` from `src/normalize/` and
`parseTorrent()` from `src/extract/cascade.ts` directly — no shim needed, nothing left
blocking this plan from starting.

---

## Verification plan

### Automated tests
- `test/rutracker/feedEntry.test.ts` — parse the real live feed XML (saved as a fixture
  in `test/fixtures/rutracker-f939.xml`) through `feedEntrySchema`; assert all 50
  entries parse correctly.
- `test/rutracker/matchEntries.test.ts` — fixture: `TitleRow[]` containing "Большой Куш"
  (with homoglyph in name) + a handful of others; assert that the three
  `Большой куш. Бангкок` feed entries from the live fixture match it and nothing else
  matches spuriously.
- `test/rutracker/fetchFeed.test.ts` — mock `fetch`, assert the parser round-trips
  correctly.
- `npm run typecheck && npm run lint && npm test` — full suite green.

### Manual verification
- Run a real ingest and confirm the log shows `feedEntriesMatched > 0` for shows known
  to be in the library (Большой Куш is in the feed right now — two entries for season 2).
- Hit `GET /api/feed` and confirm the response includes those entries with the correct
  `title_id` resolved.

---

## Explicitly out of scope

- **Downloading or adding torrents to TorBox** — the scraper is purely observational.
  It tells you "a new torrent appeared for a show you track"; it does not touch the
  TorBox `addTorrent` API. That is a separate user-initiated action.
- **Notification delivery** — `notified_at` column is reserved for Milestone 6's webhook
  boundary. This plan writes `NULL` and stops there.
- **Other forums** — the `RUTRACKER_FEED_URLS` env var makes this extensible, but the
  plan only tests against f/939.
- **Torrent file / magnet link extraction** — the Atom feed doesn't include the magnet
  or `.torrent` URL inline; that would require an authenticated scrape of the topic page.
  Out of scope; the `url` column stores the topic URL so a human can click through.
