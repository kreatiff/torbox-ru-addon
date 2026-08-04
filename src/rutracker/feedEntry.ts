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

function extractHref(link: unknown): unknown {
  if (typeof link === 'object' && link !== null && '@_href' in link) {
    return (link as Record<string, unknown>)['@_href'];
  }
  return link;
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
