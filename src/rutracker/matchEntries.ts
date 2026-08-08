import { parseTorrent } from '../extract/cascade.js';
import { normalise } from '../normalize/normalise.js';
import type { Title } from '../db/repositories/titlesRepo.js';
import type { FeedEntry } from './feedEntry.js';

export interface MatchedEntry {
  entry: FeedEntry;
  title: Title;
  season: number | null;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/**
 * True if `needle` occurs in `haystack` at a token boundary on both sides --
 * plain substring containment isn't enough (a title normalised to `дом`
 * must not match inside `домработница`). A boundary is the start/end of the
 * string or any non-letter/non-digit character (whitespace, punctuation),
 * checked with a Unicode-aware class so Cyrillic letters that normalise()
 * doesn't fold (most of the alphabet -- only the Latin-confusable subset
 * gets folded, see homoglyphMap.ts) still count as "inside a word" rather
 * than as a boundary.
 */
function containsAtTokenBoundary(haystack: string, needle: string): boolean {
  if (needle.length === 0) {
    return false;
  }
  let fromIndex = 0;
  for (;;) {
    const index = haystack.indexOf(needle, fromIndex);
    if (index === -1) {
      return false;
    }
    const before = index === 0 ? undefined : haystack[index - 1];
    const after = index + needle.length >= haystack.length ? undefined : haystack[index + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) {
      return true;
    }
    fromIndex = index + 1;
  }
}

function titleNameCandidates(title: Title): string[] {
  return [title.nameRu, title.nameEn, ...title.aliases]
    .filter((v): v is string => Boolean(v && v.trim().length > 0))
    .map((v) => normalise(v));
}

/**
 * Matches feed entries against the library. Direction is entry prefix ⊇
 * title name, never the reverse, so a season-suffixed entry like
 * `Большой куш. Бангкок 2 сезон` still matches `titles.name_ru =
 * 'Большой Куш'`. No fuzzy matching, no Levenshtein: exact normalised,
 * boundary-checked substring only. False negatives are acceptable; false
 * positives are not.
 *
 * Reuses `parseTorrent` (src/extract/cascade.ts) for title-cleaning and
 * season extraction rather than reimplementing `[Обновлено]`/bracket
 * stripping here -- feed entry titles are the same string format as
 * `torrents.raw_name_at_ingest`, and `resolveTitleMatch` in
 * src/ingest/pipeline.ts already does this exact cleanup for torrent names.
 * `cleanedTitle` comes back already normalised, so it isn't re-normalised
 * here.
 */
export function matchEntries(entries: FeedEntry[], titles: Title[]): MatchedEntry[] {
  const candidates = titles.map((title) => ({ title, names: titleNameCandidates(title) }));

  const matched: MatchedEntry[] = [];
  for (const entry of entries) {
    const { cleanedTitle, season } = parseTorrent(entry.rawTitle);

    const hit = candidates.find(({ names }) =>
      names.some((name) => containsAtTokenBoundary(cleanedTitle, name)),
    );
    if (hit) {
      matched.push({ entry, title: hit.title, season });
    }
  }
  return matched;
}
