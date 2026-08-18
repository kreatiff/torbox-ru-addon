import type { Title } from '../db/repositories/titlesRepo.js';
import { normalise } from '../normalize/normalise.js';

/**
 * Scheme for the synthetic id issued to a title with no `imdb_id` (issue
 * #20) -- Cinemeta can't render those, so the addon's own `meta` resource
 * carries them instead. Kept out of `tmdb:` deliberately: a vanilla Stremio
 * can't resolve a bare `tmdb:` id into a catalog card, which is exactly the
 * dead-end this feature exists to avoid (AIOStreams still *sends* `tmdb:`
 * stream requests -- see stream.ts -- but that's a different direction).
 */
export const SYNTHETIC_SCHEME = 'torboxru';
export const SYNTHETIC_PREFIX = `${SYNTHETIC_SCHEME}:`;

// titles.id is a `uuid` Postgres column (see migrations/…_init-schema.ts).
// Passing unvalidated text into getTitleById() throws a raw pg 22P02 that
// surfaces as an unhandled 500 on a route anyone on the internet can hit --
// validating the shape here first turns that into a clean 404 instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * The id a title is advertised under to Stremio -- imdb-first, so Cinemeta
 * keeps supplying the richer metadata (episode titles, thumbnails,
 * descriptions) this addon can't match. Only a title with no `imdb_id`
 * falls back to the synthetic scheme.
 */
export function stremioIdForTitle(title: Pick<Title, 'id' | 'imdbId'>): string {
  return title.imdbId ?? `${SYNTHETIC_PREFIX}${title.id}`;
}

/** Extracts and validates the title uuid from a `torboxru:<uuid>` id.
 * Returns null for anything else, including a malformed uuid -- callers
 * turn that into a 404, never a DB round trip. */
export function parseSyntheticId(raw: string): string | null {
  if (!raw.startsWith(SYNTHETIC_PREFIX)) {
    return null;
  }
  const id = raw.slice(SYNTHETIC_PREFIX.length);
  return isValidUuid(id) ? id : null;
}

export interface MetaPreview {
  id: string;
  type: 'series';
  name: string;
  poster?: string;
  posterShape: 'poster';
  releaseInfo?: string;
}

export interface MetaVideo {
  id: string;
  title: string;
  season: number;
  episode: number;
  released?: string;
}

export interface Meta extends MetaPreview {
  videos: MetaVideo[];
}

function padEpisode(n: number): string {
  return String(n).padStart(2, '0');
}

/** Catalog-card projection of a title (§5.5-adjacent, issue #20). `poster`
 * is omitted entirely (not `null`) when there is none -- Stremio clients
 * treat a present-but-null poster field inconsistently, an omitted key is
 * unambiguous. */
export function toMetaPreview(
  title: Pick<Title, 'id' | 'imdbId' | 'nameRu' | 'nameEn' | 'year' | 'posterUrl'>,
): MetaPreview {
  const preview: MetaPreview = {
    id: stremioIdForTitle(title),
    type: 'series',
    name: title.nameRu || title.nameEn || 'Untitled',
    posterShape: 'poster',
  };
  if (title.posterUrl) {
    preview.poster = title.posterUrl;
  }
  if (title.year) {
    preview.releaseInfo = String(title.year);
  }
  return preview;
}

/**
 * Full meta detail for the addon's own `meta` route: the catalog preview
 * plus a `videos[]` entry per mapped episode. `videos[].id` is a hard
 * contract with stream.ts's parseStreamId -- it's the exact id Stremio
 * hands back to `/stream/series/:id.json` when the viewer picks an episode,
 * so it must always be `${metaId}:${season}:${episode}`.
 *
 * `releasedBySeasonEpisode` is an optional `"season:episode" -> air_date`
 * lookup (from provider_seasons, already cached by src/metadata/tmdb.ts) --
 * left undefined/missing entries just omit `released` rather than guessing.
 */
export function toMetaDetail(
  title: Pick<Title, 'id' | 'imdbId' | 'nameRu' | 'nameEn' | 'year' | 'posterUrl'>,
  episodes: { season: number; episode: number }[],
  releasedBySeasonEpisode?: Map<string, string | null>,
): Meta {
  const preview = toMetaPreview(title);
  const videos: MetaVideo[] = episodes.map(({ season, episode }) => {
    const video: MetaVideo = {
      id: `${preview.id}:${season}:${episode}`,
      title: `S${padEpisode(season)}E${padEpisode(episode)}`,
      season,
      episode,
    };
    const released = releasedBySeasonEpisode?.get(`${season}:${episode}`);
    if (released) {
      video.released = released;
    }
    return video;
  });
  return { ...preview, videos };
}

/** Catalog page size -- Discover pagination via the `skip` extra. */
export const CATALOG_PAGE_SIZE = 100;

export interface CatalogExtra {
  search?: string;
  skip: number;
}

/**
 * Parses the optional `/:extraJson` segment of a catalog request (e.g.
 * `search=foo&skip=100.json`, already stripped of `.json` by the caller).
 * Stremio percent-encodes the whole extra string, but Fastify's own param
 * decoding already undoes that by the time this runs, so plain
 * URLSearchParams parsing is enough. `skip` is clamped to a non-negative
 * integer -- same posture as the limit/offset validation on GET
 * /api/activity -- with anything unparsable treated as 0 rather than
 * rejected, since an out-of-contract extra here isn't the caller's fault.
 */
export function parseCatalogExtra(raw: string | undefined): CatalogExtra {
  if (!raw) {
    return { skip: 0 };
  }
  const params = new URLSearchParams(raw);
  const search = params.get('search');
  const skipRaw = Number(params.get('skip'));
  const skip = Number.isInteger(skipRaw) && skipRaw > 0 ? skipRaw : 0;
  return search ? { search, skip } : { skip };
}

/** Case/script-insensitive substring filter over name_ru/name_en/aliases,
 * reusing normalise() (src/normalize/normalise.ts) so a Cyrillic search
 * folds homoglyphs and ё/е the same way findTitleByCleanedName's exact
 * match already does -- a raw substring match on the raw strings would miss
 * exactly the mixed-script names this library is full of. */
export function matchesSearch(
  title: Pick<Title, 'nameRu' | 'nameEn' | 'aliases'>,
  search: string,
): boolean {
  const target = normalise(search);
  if (!target) {
    return true;
  }
  return (
    normalise(title.nameRu).includes(target) ||
    (!!title.nameEn && normalise(title.nameEn).includes(target)) ||
    title.aliases.some((a) => normalise(a).includes(target))
  );
}
