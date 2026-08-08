import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { parseFeedEntry, type FeedEntry } from './feedEntry.js';

const DEFAULT_FEED_URL = 'https://feed.rutracker.cc/atom/f/939.atom';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function feedUrls(): string[] {
  return config.rutrackerFeedUrls && config.rutrackerFeedUrls.length > 0
    ? config.rutrackerFeedUrls
    : [DEFAULT_FEED_URL];
}

/**
 * Fetches and parses one feed URL. Never throws: a failed GET, a non-OK
 * status, malformed XML, or a body with no <entry> at all all degrade to an
 * empty array plus a logged warning -- the same soft-fail posture
 * `refreshWebdav` uses for its own optional network call. RuTracker being
 * unreachable must not take the rest of the ingest run down with it.
 */
async function fetchOneFeed(url: string): Promise<FeedEntry[]> {
  let xml: string;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn(
        { url, status: response.status },
        'RuTracker feed returned a non-OK status; skipping this poll',
      );
      return [];
    }
    xml = await response.text();
  } catch (err) {
    logger.warn({ err, url }, 'Failed to fetch RuTracker feed; continuing without it');
    return [];
  }

  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    logger.warn({ err, url }, 'Failed to parse RuTracker feed XML; continuing without it');
    return [];
  }

  const rawEntries = (parsed as { feed?: { entry?: unknown } } | undefined)?.feed?.entry;
  if (!rawEntries) {
    return [];
  }
  const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];

  const results: FeedEntry[] = [];
  for (const raw of entries) {
    const entry = parseFeedEntry(raw as Parameters<typeof parseFeedEntry>[0]);
    if (entry) {
      results.push(entry);
    } else {
      logger.warn({ url, raw }, 'Skipping malformed RuTracker feed entry');
    }
  }
  return results;
}

/**
 * Polls every configured RuTracker Atom feed URL (RUTRACKER_FEED_URLS, or
 * the single hardcoded default forum) and returns the union of their
 * entries. Never throws -- see fetchOneFeed.
 */
export async function fetchFeed(): Promise<FeedEntry[]> {
  const results = await Promise.all(feedUrls().map(fetchOneFeed));
  return results.flat();
}
