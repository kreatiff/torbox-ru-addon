# Walkthrough - Milestone 4: Labeller UI

Milestone 4 (the Labeller UI, TMDB metadata search, and Basic Auth integration) has been successfully implemented and verified.

## Summary of Changes

### 1. Configuration & Caching Layers
* **Environment variables:** Added `TMDB_API_KEY`, `ADMIN_USER`, and `ADMIN_PASS` configuration keys to `src/config.ts` with safe defaults (`admin`/`admin` in development).
* **Provider cache schema:** Added `providerSeasonRowSchema` matching the `provider_seasons` caching table in `src/db/schema.types.ts`.
* **Database repositories:**
  * Created `providerSeasonsRepo.ts` under `src/db/repositories/` to cache TMDB season episode sizes and air dates.
  * Extended `titlesRepo.ts` with `findOrCreateTitle` (lookup by TMDB/IMDb/TVDB IDs or insert) and `listTitlesWithSeasons` (used for the library coverage grid).
  * Extended `rulesRepo.ts` with `upsertRule` and `getRuleByTorrentAndSeason`.

### 2. Metadata Provider
* Created `tmdb.ts` implementing search and season metadata fetching.
* Supported modern TMDB v4 Bearer (JWT) tokens as well as v3 API Keys, preventing authentication configuration confusion.

### 3. Fastify Gated Admin Routes
* **Authentication Hook:** Created `verifyBasicAuth.ts` utilizing timing-safe digest comparisons to gate administrative endpoints.
* **JSON API Router:** Created `api.ts` containing endpoints for:
  * `/api/queue` (review queue with basic text-extracted show/season proposals).
  * `/api/torrents/:hash` (torrent file natural-sort list).
  * `/api/titles/search` (TMDB series search).
  * `/api/rules` (save rule, populate title & seasons cache, and rebuild mappings).
  * `/api/library` (mapped shows and episode coverage status grid).
  * `/api/health` (last ingest run, play log, gone torrents, dangling mappings, files without mount paths).
  * `/api/ingest/run` (async background trigger).
* **Static Assets Server:** Created `admin.ts` serving the compiled React assets under the `/admin` prefix using `@fastify/static`. Configured dynamic file paths to support both Vitest runtimes and production compiled runtimes. Added a fallback handler to support React client-side Router redirection.
* Registered the routes in `server.ts`.

### 4. React + Vite Frontend
* Scaffolded a React + Vite + TypeScript workspace in `ui/`.
* Configured Vite build variables (`base: '/admin/'` and `outDir: '../dist/ui'`).
* Custom styled with Inter and JetBrains Mono fonts and a dark, low-chroma design system.
* Implemented views:
  * **Queue View:** Keyboard navigable (`j`/`k`/`Enter`/`a` quick-approve shortcuts) list of active unruled torrents.
  * **Labeller View:**
    * Left pane: Displays raw torrent name highlighting homoglyphs (using token-majority script checking) and files.
    * Right pane: TMDB search picker with poster support, rules settings, and per-file exceptions override dropdowns.
    * Live Preview Table: Re-calculates and renders `expandRule` mapping client-side as rule options adjust.
    * Banners: Validation banners checking file counts against TMDB seasons or `X из Y` torrent title patterns.
  * **Library View:** Displays cards for each mapped show, grouping seasons into coverage grids (covered green boxes, missing dark boxes, and duplicate orange boxes).
  * **Health View:** Diagnostics displaying plays history, gone torrents, and mount counts, along with an "Ingest Now" trigger.

### 5. Production & Operational Pipeline
* Updated the multi-stage `Dockerfile` to build the Vite frontend inside the `build` container and pack the output `/dist/ui` folder into the runtime environment.
* Excluded local packages and logs from Docker in `.dockerignore`.

---

## Verification Results

### 1. Automated Tests
Ran the entire backend test suite including the new Basic Auth and TMDB tests. All tests pass successfully:
```
✓ test/http/api.test.ts (4 tests) 209ms
✓ test/http/addon.test.ts (20 tests | 7 skipped) 159ms
✓ test/metadata/tmdb.test.ts (5 tests) 6ms
✓ test/torbox/envelope.test.ts (6 tests) 5ms
✓ test/resolve/expandRule.test.ts (10 tests) 4ms
✓ test/torbox/schemas.test.ts (5 tests) 4ms

Test Files  6 passed | 7 skipped (13)
     Tests  43 passed | 33 skipped (76)
  Duration  4.15s
```

### 2. Frontend Compilation Build
Successfully built and compiled Vite React static assets:
```
vite v8.2.0 building client environment for production...
transforming...✓ 1833 modules transformed.
rendering chunks...
computing gzip size...
../dist/ui/index.html                   0.70 kB │ gzip:  0.38 kB
../dist/ui/assets/index-D1ekkmmx.css    8.80 kB │ gzip:  2.20 kB
../dist/ui/assets/index-DliISWc9.js   257.21 kB │ gzip: 78.82 kB

✓ built in 5.44s
```

### 3. Backend Compilation Build
TypeScript backend builds and compiles cleanly into `dist/`:
```
> tsc -p tsconfig.json
Completed successfully with exit code 0.
```
