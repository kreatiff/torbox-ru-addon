# Build spec: `torbox-ru` — Stremio addon for Russian TV in a TorBox library

You are building a self-hosted Stremio addon that makes an existing TorBox cloud
library playable in Stremio / Nuvio / AIOStreams. Read this whole document before
writing code. Ask me before deviating from any decision marked **LOCKED**.

---

## 1. The problem

I have a TorBox account with a few hundred cached torrents, many of them Russian TV
shows. Stremio can't see them. Public addons can't find them either, because the
releases are indexed under Russian titles that no English-language indexer carries.

The releases also don't follow Scene naming. Real examples from my library:

```
Torrent: Сокровища императора 3 сезон 8 из 13 выпуск (Ольга Бузова и Михаил Галустян)
         [2026, путешествие, реалити-шоу, развлекательный, HDRip 1080p]
Files:   01 выпуск.mp4, 02 выпуск.mp4, ... 08 выпуск.mp4      (5GB each)

Torrent: Ставка на любовь 2 сезон 10 из 10 выпуск (Регина Тодоренко и Влад Топалов)
         [2026, реалити, WEBRip, 1080p]
Files:   01 выпуск.mp4 ... 10 выпуск.mp4

Torrent: Bolshoy.Kush.s02.E02.(2026).HDTV.(1080p).by.Nicodem.Files-x (Эфир от 12.07.2026)
Files:   14.Большой куш. Бангкок.s02.E02.(2026).HDTV.(1080р).by.Nicodem.Files-x
         (Эфир от 12.07.2026).ts
```

The system's job: map each **file** in my TorBox library to a
`(series, season, episode)` triple, then serve those as Stremio streams.

**The mapping is rule-based and human-supervised.** Automatic parsing produces
*proposals*; I confirm or correct them in a web UI. This is a deliberate design
choice — do not try to build a fully automatic classifier.

---

## 2. Environment — **LOCKED**

- Oracle Cloud, Ubuntu, **ARM64 (Ampere A1)**. Every image and native dep must be
  `linux/arm64`. Do not pull `amd64`-only images. No hardware video encode.
- Deploy via **Docker Compose**. Single service, plus Postgres.
- Node 22 + TypeScript, ESM, strict mode.
- Fastify for HTTP. No Stremio addon SDK — write the routes directly.
- Postgres 16 (container). Not Supabase; plain Postgres with a migration tool
  (`node-pg-migrate` or Drizzle — your call, pick one and be consistent).
- Exposed publicly via Cloudflare Tunnel. Assume no network-level auth.

---

## 3. Domain rules — read carefully, these are the whole project

### 3.1 Homoglyph normalisation (do this first, everywhere)

Russian releasers mix Cyrillic and Latin letters *within the same release*. In the
Bolshoy Kush example the torrent name has Latin `(1080p)` and the file has Cyrillic
`(1080р)` — U+0440 vs U+0070. Any regex written against `1080p` silently fails on
one of them, leaves a bare `1080` in the string, and poisons number extraction.

Build `normalise(s: string)` that folds Cyrillic→Latin homoglyphs before anything
else touches the string:

```
а→a  е→e  о→o  р→p  с→c  у→y  х→x  і→i  ѕ→s  ј→j
А→A  В→B  Е→E  К→K  М→M  Н→H  О→O  Р→P  С→C  Т→T  У→Y  Х→X
```

Also fold `ё→е`, collapse whitespace, lowercase. Keep the original string intact —
normalisation is for matching only, never for display.

### 3.2 Token masking before number extraction

Numbers are everywhere and most of them are not episode numbers. Mask in this order:

1. Air dates: `Эфир от DD.MM.YYYY` → capture the date, replace with a placeholder.
2. Years: `\(?(19|20)\d{2}\)?`
3. Quality/codec tokens: `1080p 720p 2160p 4K HDTV HDRip WEBRip WEB-DL BDRip
   x264 x265 H.264 H.265 HEVC AVC AAC AC3 DTS DD5.1 5.1 2.0 MP4 MKV TS`
4. Release groups: `by\.\w+`, `Files-x`, `Nicodem`, and a configurable list.
5. Season/episode markers (capture, then mask).

Only then look for bare numbers.

### 3.3 Episode vocabulary

Russian TV uses different words by genre. Scripted drama uses `серия`; reality and
variety use `выпуск`. Support all of:

```
серия | серии | серию | выпуск | выпуска | выпуски | эпизод | эп. | часть
```

### 3.4 `X из Y` is a completeness count, NOT an episode number — **LOCKED**

`3 сезон 8 из 13 выпуск` means *season 3, 8 episodes present of 13 total*. It is
**not** episode 8.

Use it as a **validation key**:

- `Y` = expected total episodes in the season → cross-check against TVDB/TMDB.
- `X` = number of episodes in this torrent → **must equal the video file count**.
  When it does, mark the proposal high-confidence and auto-commit.
  When it doesn't, queue for review and say why.

`A-B из Y` (e.g. `01-16 из 16`) is a range form; same logic, `X = B - A + 1`.

### 3.5 Extractor priority — **LOCKED**

Run in this order, first match wins:

1. `[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})` — note the separator; `s02.E04` is common.
2. `(\d{1,3})\s*(серия|выпуск|эпизод|часть)` and the reversed form.
3. Air date → episode lookup against the metadata provider's air dates.
4. Leading bare number after masking (`01 выпуск.mp4` → 1).
5. Positional: natural-sort video files, drop size outliers, index → episode.

**Never let a leading bare number override an explicit `SxxExx`.** In the Bolshoy
Kush file, `14.` is an *absolute* episode number (season 1 had 12 episodes, so
absolute 14 = S02E02) while `s02.E02` is the aired-order truth. Extract the leading
number as a **cross-check signal** (`absolute_hint`), not as the episode.

### 3.6 Single-file torrents

If a torrent contains exactly one video file, parse the **torrent name** and ignore
the file name entirely. This resolves a large class of weekly single-episode
releases with no extra logic.

### 3.7 Rules, not per-file mappings — **LOCKED**

Store one **rule** per (torrent, season). Materialise per-file mappings from it.

```ts
type Rule = {
  torrentHash: string;
  titleId: string;
  season: number;
  numbering: 'sequential' | 'parsed' | 'continuous' | 'manual';
  sort: 'natural' | 'path';
  startEpisode: number;        // default 1
  absoluteOffset: number | null; // for 'continuous'
  exceptions: Record<string /* fileId */, { season: number; episode: number } | 'ignore'>;
};
```

Fixing a rule re-maps 40 files instantly. If mappings were the source of truth,
every correction would be 40 edits and I'd stop doing it. This is the single most
important structural decision in the project.

`sort: 'natural'` matters: lexical sort turns `1, 2, 10` into `1, 10, 2` and shifts
every episode silently.

---

## 4. Data model

```sql
-- Immutable ingest snapshot. NEVER updated after insert.
torrents (
  hash              text primary key,
  torbox_id         bigint not null,
  raw_name_at_ingest text not null,   -- parse from THIS, never live data
  current_name      text,             -- may drift; display only
  total_size        bigint,
  cached_at         timestamptz,
  added_at          timestamptz,
  first_seen        timestamptz not null default now(),
  last_seen         timestamptz not null,
  status            text not null default 'active'  -- active | gone
)

files (
  id            bigserial primary key,
  torrent_hash  text references torrents(hash) on delete cascade,
  torbox_file_id bigint not null,
  raw_path      text not null,        -- as returned by the API
  mount_path    text,                 -- as discovered on the WebDAV mount, nullable
  size          bigint not null,
  is_video      boolean not null,
  unique (torrent_hash, torbox_file_id)
)

titles (
  id        uuid primary key,
  imdb_id   text unique,              -- NULLABLE. not the primary key.
  tvdb_id   integer,
  tmdb_id   integer,
  name_ru   text not null,
  name_en   text,
  year      integer,
  aliases   text[] not null default '{}'
)

rules (
  id            uuid primary key,
  torrent_hash  text references torrents(hash) on delete cascade,
  title_id      uuid references titles(id),
  season        integer not null,
  numbering     text not null,
  sort          text not null default 'natural',
  start_episode integer not null default 1,
  absolute_offset integer,
  exceptions    jsonb not null default '{}',
  confidence    real not null,
  source        text not null,        -- 'auto' | 'manual'
  created_at    timestamptz not null default now(),
  unique (torrent_hash, season)
)

mappings (                            -- materialised from rules; safe to rebuild
  file_id   bigint references files(id) on delete cascade,
  title_id  uuid references titles(id),
  season    integer not null,
  episode   integer not null,
  rule_id   uuid references rules(id) on delete cascade,
  primary key (file_id)
)
create index on mappings (title_id, season, episode);

play_log (
  id        bigserial primary key,
  file_id   bigint,
  at        timestamptz not null default now(),
  user_agent text
)
```

**`imdb_id` is nullable and is not the primary key.** Some shows have no IMDb
entry, and some have an entry with no episode records for the current season.
Key everything on `titles.id` internally.

**Multiple files may map to the same episode** — a `8 из 13` torrent gets
superseded by a `13 из 13` one and I'll hold both. `mappings` is keyed on
`file_id`, not on `(title, season, episode)`. The stream handler returns all
candidates, newest cache date first.

---

## 5. Components

### 5.1 `src/torbox/` — API client

- Base `https://api.torbox.app/v1/api`, bearer auth from `TORBOX_API_KEY`.
- `GET /torrents/mylist?bypass_cache=true` for the torrent list.
- **The list response may not include per-file arrays.** Probe this on first run and
  handle both shapes: if `files` is absent, fetch each torrent individually via
  `?id={id}`. Note that with `id` set, `.data` is an **object**, not an array.
- Only fetch files for hashes not already in `torrents`. Rate-limit yourself.
- `GET /torrents/requestdl?token=KEY&torrent_id=N&file_id=M&redirect=true` returns a
  302 to a signed CDN URL. Call this **server-side only**.
- WebDAV force-refresh: `POST https://webdav.torbox.app/refresh/`. The WebDAV view
  only updates every 15 minutes otherwise.

Every response must be parsed through a zod schema. Log the raw body on schema
failure — the API returns `{"success":false,...,"data":null}` on auth errors,
which looks identical to an empty library if you don't check `success`.

### 5.2 `src/ingest/`

```
refresh WebDAV  →  fetch mylist  →  upsert torrents (snapshot raw_name once)
                →  fetch files for new hashes
                →  mark absent hashes status='gone'
                →  propose rules for unruled torrents
                →  rebuild mappings
                →  notify if anything needs review
```

Run on a schedule inside the container (`node-cron` or a systemd timer calling an
HTTP endpoint — prefer in-process). Also expose `POST /api/ingest/run` so the UI can
trigger it.

**Optional mount discovery pass.** If `TORBOX_MOUNT_PATH` is set, walk it once per
run and build a `(basename, size) → real_path` index, then populate
`files.mount_path`. This makes the system immune to WebDAV path sanitisation and to
TorBox's "flatten" and tag-folder settings. Match on size as the tiebreaker.

### 5.3 `src/resolve/`

`expandRule(rule, files): Mapping[]` — a **pure function**. No I/O, no DB. This is
the part I'll be tweaking for months, so it must be trivially testable.

`proposeRule(torrent, files, titleCandidates): RuleProposal` — runs the extractor
cascade, computes a confidence score, returns a rule plus a human-readable
explanation of how it got there. The explanation is shown in the UI.

Confidence should be dominated by **cross-validation**, not pattern strength:

| Signal | Weight |
|---|---|
| File count matches `X` from `X из Y` | high |
| File count matches provider's episode count for that season | high |
| Every file yielded an explicit `SxxExx` | high |
| `absolute_hint` consistent with cumulative season offsets | medium |
| Air dates align with provider air dates | medium |
| Positional fallback used | low — always queue for review |

### 5.4 `src/metadata/`

Provider lookups for title resolution and episode counts. TMDB (has Russian
`original_name` and alternative titles) plus TheTVDB. Cache aggressively in Postgres
— these change rarely.

Expose `searchTitles(query, lang)` for the UI's show picker, searching Cyrillic
directly.

**Do not assume a provider has the current season.** Several of my shows have full
season 1–2 data and nothing for season 3. Surface that gap in the UI rather than
failing.

### 5.5 `src/http/` — the addon

**LOCKED: config token in the URL path.** The Cloudflare Tunnel hostname is public
and the Stremio protocol has no auth. Follow the Torrentio convention:

```
GET  /:token/manifest.json
GET  /:token/stream/series/:id.json      -- id = tt1234567:3:8
GET  /:token/play/:fileId                -- 302 → signed TorBox URL
```

Validate `:token` against `ADDON_TOKEN` on every route. Constant-time compare.

**LOCKED: never return a URL containing `TORBOX_API_KEY`.** The tempting shortcut is
returning `requestdl?token=KEY&...&redirect=true` directly. That URL ends up in
Stremio's cache, Nuvio's logs, and anywhere a stream gets shared. Always redirect
through `/play/:fileId`. Bonus: it gives you `play_log`, which reveals which
mappings are actually being used and which are quietly wrong.

Manifest:

```json
{
  "id": "casa.dominus.torbox-ru",
  "version": "0.1.0",
  "name": "TorBox RU",
  "resources": ["stream"],
  "types": ["series", "movie"],
  "idPrefixes": ["tt"],
  "catalogs": []
}
```

Stream objects:

```ts
{
  name: 'TorBox RU',
  description: `${torrentDisplayName}\n${prettySize}${lowConfidence ? ' ⚠' : ''}`,
  url: `${PUBLIC_BASE}/${token}/play/${fileId}`,
  behaviorHints: {
    bingeGroup: `torbox-ru-${titleId}-${season}`,
    notWebReady: isTransportStream   // .ts files
  }
}
```

`bingeGroup` is what makes Stremio auto-advance to the next episode from the same
source. Get it right.

`.ts` (MPEG-TS) files are common in my library and may need `notWebReady: true`.
Make it a per-file computed flag with an env override.

### 5.6 `src/ui/` — the labelling interface

This is where I'll actually spend my time, so it needs to be good. Same Fastify
process, served at `/admin`, behind HTTP basic auth (`ADMIN_USER` / `ADMIN_PASS`)
**plus** the Cloudflare Tunnel. React + Vite, built into static assets at image
build time. TanStack Query for data. No SSR.

**Screens:**

1. **Queue** — torrents needing review, newest first. Columns: torrent name, file
   count, proposed show, proposed season, confidence, why. Keyboard navigable:
   `j`/`k` to move, `Enter` to open, `a` to accept the proposal as-is.

2. **Labeller** — the core screen. Two panes.
   - Left: torrent name (raw, monospace, homoglyphs visually flagged), full file
     list with sizes.
   - Right: show picker (searches Cyrillic against TMDB/TVDB, shows poster + year +
     per-season episode counts), season selector, numbering mode, sort mode, start
     episode, absolute offset.
   - **Below both: a live preview table** — `file → S03E01` for every file, updating
     as I change any control. This is non-negotiable; it's how off-by-ones get caught
     before they're committed.
   - Per-row override dropdowns for the exceptions map, plus an "ignore this file"
     toggle for trailers and extras.
   - Validation banners: "13 files, TVDB says season 3 has 13 episodes ✓" or
     "10 files but torrent title says 8 из 13 ✗".

3. **Library** — everything mapped, grouped by show → season, with the episode grid
   showing which episodes are covered, which are missing, and which have duplicates.

4. **Health** — last ingest run, torrents marked `gone`, dangling mappings, files
   with no `mount_path`, recent plays.

**Visual direction.** Deliberately not a generic admin dashboard. This is a tool for
reading dense, messy, multi-alphabet strings, so treat text rendering as the design:

- A single monospace face with genuine Cyrillic coverage — **JetBrains Mono** — for
  all filenames, torrent names, and the preview table. A clean grotesque
  (**Inter**) for chrome and controls only. Never render a filename in a
  proportional face.
- Dark, low-chroma base. Two accents only: one for *confirmed*, one for *needs
  attention*. Confidence is communicated by a small numeric badge, never by a colour
  gradient across a row.
- **Signature element: the homoglyph inspector.** Any character in a filename whose
  script differs from the surrounding run gets a subtle underline and a hover
  tooltip naming the codepoint (`U+0440 CYRILLIC SMALL LETTER ER`). This is the one
  piece of visual boldness in the app, and it directly serves the hardest thing about
  the domain — it makes the invisible bug visible.
- Preview table rows align on the `SxxExx` column so a mis-numbered run is obvious
  at a glance.
- Density over whitespace. I'm scanning 40-row file lists, not reading a landing page.
- Keyboard focus states must be visible. Respect `prefers-reduced-motion`.

Copy rule: name things by what I control. "Needs review", not "Unresolved entities".
Errors say what happened and what to do about it.

---

## 6. Build order — **LOCKED**

Do not skip ahead. Milestone 3 must work before you write any parsing code.

1. **Ingest only.** TorBox client, schema, migrations, `mylist` → Postgres with
   snapshots. Docker Compose up on ARM64. No matching, no UI.
2. **Two rules inserted by hand as SQL.** Verify `expandRule` materialises correct
   mappings.
3. **Manifest + stream + play.** Install in Stremio and in AIOStreams as a custom
   addon. **Confirm actual playback of a `.ts` file and an `.mp4` file.** The data
   model is free to change until this works and expensive to change after.
4. **Labeller UI.** Queue, labeller, preview table.
5. **Auto-proposal engine.** Extractor cascade, normalisation, confidence scoring.
6. **Health screen, ingest scheduling, notifications.**

---

## 7. Testing

`test/fixtures/` holds real torrent names and file lists from my library — the ones
in §1 to start. Every parsing rule gets a fixture-driven test. `expandRule` gets
exhaustive unit tests including the pathological cases: lexical-vs-natural sort,
continuous numbering across a season boundary, a torrent with a trailer file, a
torrent where file count disagrees with `X из Y`.

Do not test against live TorBox. Record fixtures.

---

## 8. Non-goals for v1

- Searching indexers. This serves my existing cache only.
- Catalog / meta resources and synthetic IDs for shows Cinemeta doesn't carry. The
  schema allows it (`imdb_id` nullable) but don't build it yet.
- Movies. Types include `movie` in the manifest but the pipeline is series-first.
- Writing back to TorBox. The API's edit endpoint is torrent-level only and there is
  no file rename. Treat TorBox as read-only.
- Any n8n involvement. Notifications may POST to a webhook URL; that's the boundary.

---

## 9. Known traps

- ARM64 only. Check every base image.
- `{"success": false, "data": null}` from TorBox looks like an empty library.
- TorBox WebDAV is read-only and refreshes every 15 min; force-refresh before ingest.
- TorBox's "flatten" WebDAV setting destroys directory structure. Tag folders may
  relocate items. Both are reasons to discover paths rather than construct them.
- TorBox's own IMDb tags can be wrong. Treat as a suggestion needing confirmation —
  a plausible-but-wrong IMDb ID is the worst failure mode available, because it maps
  files onto a real show's episode list and looks like it worked.
- Cyrillic in filenames: sanitise `<>:"/\|?*` for any generated path, but do not
  strip Cyrillic.
- Providers may have a series but not its current season. Handle the gap explicitly.

---

## 10. First response

Before writing code: restate the architecture in your own words, list anything in
this spec that's underspecified or that you disagree with, and propose the exact file
tree. Then stop and wait for my go-ahead.
