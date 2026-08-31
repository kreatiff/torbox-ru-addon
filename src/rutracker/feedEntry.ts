import { z } from 'zod';

export const feedEntrySchema = z.object({
  topicId: z.number().int().positive(),
  url: z.url(),
  rawTitle: z.string().min(1),
  updatedAt: z.date(),
});
export type FeedEntry = z.infer<typeof feedEntrySchema>;

// <id>tag:rto.feed,YYYY-MM-DD:/t/<topicId></id> -- the RuTracker topic ID is
// the stable external key, shared with the numeric ?t= query param on
// <link href>, so it's extracted from <id> rather than parsed out of the URL.
const TOPIC_ID_FROM_ATOM_ID = /\/t\/(\d+)\s*$/;

export function extractTopicId(atomId: string): number | null {
  const match = TOPIC_ID_FROM_ATOM_ID.exec(atomId);
  if (!match?.[1]) {
    return null;
  }
  return parseInt(match[1], 10);
}

interface RawAtomEntry {
  id?: unknown;
  link?: unknown;
  title?: unknown;
  updated?: unknown;
}

/**
 * RuTracker's feed now emits a second `<link rel="enclosure" href="magnet:…">`
 * alongside the topic-page `<link>` on every entry -- fast-xml-parser folds
 * two same-named sibling tags into an array instead of a single object once
 * that happens (verified directly against the parser), which this used to
 * not handle at all: it returned the whole array as `url`, `feedEntrySchema`
 * (a `z.url()`) rejected it, and every single entry started getting dropped
 * as "malformed" -- feed polling degraded to silently ingesting nothing new,
 * with no error anywhere (fetchOneFeed's soft-fail posture is deliberate for
 * real outages, but that's not what this was). Picks the first link that
 * isn't the magnet enclosure, whether there's one link or several.
 */
function extractHref(link: unknown): unknown {
  const links = Array.isArray(link) ? link : [link];
  for (const candidate of links) {
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      '@_href' in candidate &&
      (candidate as Record<string, unknown>)['@_rel'] !== 'enclosure'
    ) {
      return (candidate as Record<string, unknown>)['@_href'];
    }
  }
  return undefined;
}

/**
 * Builds and validates a FeedEntry from the raw fields fast-xml-parser hands
 * back for one <entry>. Never throws -- returns null on anything malformed,
 * the same "log and skip" pattern the TorBox client uses for envelope
 * failures; fetchFeed logs the skip.
 */
export function parseFeedEntry(raw: RawAtomEntry): FeedEntry | null {
  if (typeof raw.id !== 'string') {
    return null;
  }
  const topicId = extractTopicId(raw.id);
  if (topicId === null) {
    return null;
  }

  const result = feedEntrySchema.safeParse({
    topicId,
    url: extractHref(raw.link),
    rawTitle: raw.title,
    updatedAt: typeof raw.updated === 'string' ? new Date(raw.updated) : raw.updated,
  });
  return result.success ? result.data : null;
}
