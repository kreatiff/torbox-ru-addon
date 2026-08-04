# RuTracker feed scraper implementation plan

> Status: proposed, not started. Written against `dev` after Milestone 4 merge.
> Intended to be implemented after Milestone 5 Step 1 (`src/normalize/`) ships,
> since `matchEntries` reuses `normalise()` from that module.

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

The title string is the _same_ format as `torrents.raw_name_at_ingest` — meaning the
Milestone 5 extractor cascade will eventually be able to parse episode numbers out of it.
For this scraper's matching step, we use `src/normalize/` output only (no extraction
needed — we're matching by show name, not episode).

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

#### [NEW] `matchEntries.ts`
- `matchEntries(entries: FeedEntry[], titles: TitleRow[]): MatchedEntry[]`
- For each entry: strip the `[Обновлено]` prefix, strip the bracketed metadata suffix
  (`[2026, реалити-шоу, ...]`), normalise the remaining prefix with `normalise()`.
- For each title: normalise `name_ru` (and `name_en` if set), plus each alias.
- Match = a normalised entry prefix **starts with** or **contains** any normalised title
  string (direction: entry prefix ⊇ title name, not the reverse, to handle season
  suffixes like `Большой куш. Бангкок 2 сезон`).
- Returns `{ entry, title, season? }` — `season` parsed from the title string by the same
  vocabulary patterns the extractor uses (a "best effort" here, not the full cascade).
- No fuzzy matching, no Levenshtein — exact normalised substring only. If it doesn't
  match, it doesn't match. False negatives are acceptable; false positives are not.

---

### New: `feed_entries` table (additive migration)

```sql
CREATE TABLE feed_entries (
  topic_id      integer       PRIMARY KEY,  -- RuTracker topic ID
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

**Key design decisions:**
- `topic_id` (not a surrogate uuid) is the PK — the RuTracker topic is the stable
  external key. `ON CONFLICT (topic_id) DO UPDATE SET last_updated = ...` is the
  upsert path for `[Обновлено]` entries.
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

A new step inserted between "mark absent gone" and "rebuild mappings":

```
refresh webdav → fetch mylist → upsert torrents → fetch files → mark absent gone
  → poll feed + match against library + upsert feed_entries   # NEW — this plan
  → propose rules for unruled torrents                         # Milestone 5
  → rebuild mappings                                           # existing
  → notify if anything needs review                           # Milestone 6
```

The step:
1. Fetches all `titles` rows from `titlesRepo.listAll()` (a new read, cheap — the table
   is small)
2. Calls `fetchFeed()` and `matchEntries()`
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

- `GET /api/feed` — returns paginated `feed_entries` rows (newest `last_updated` first),
  with `title_id` joined to `titles.name_ru`. Useful for the Health/Library views to show
  "new episodes seen in feed since last ingest."

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

## Dependency on Milestone 5

The `matchEntries` title-strip step reuses `normalise()` from `src/normalize/`, which
Milestone 5's Step 1 builds. The feed scraper does **not** need the full extractor cascade
— only normalisation, not episode extraction. So:
- **If `src/normalize/` ships first** (as Milestone 5 intends): use it directly.
- **If the feed scraper ships before Milestone 5 step 1**: inline a minimal
  `normalise()` shim (lowercase + collapse whitespace + basic Cyrillic→Latin fold for the
  most common confusables) inside `src/rutracker/`, then replace it with the real import
  once `src/normalize/` exists. The shim is safe to swap because `matchEntries` is pure
  and has no I/O.

**Recommendation:** build this after Milestone 5 Step 1.

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
