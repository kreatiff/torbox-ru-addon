import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { describe, it, expect } from 'vitest';
import { extractTopicId, parseFeedEntry } from '../../src/rutracker/feedEntry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const xml = readFileSync(path.join(__dirname, '../fixtures/rutracker-f939.xml'), 'utf-8');
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

describe('extractTopicId', () => {
  it('extracts the topic id from the atom <id> tag format', () => {
    expect(extractTopicId('tag:rto.feed,2026-08-02:/t/6890150')).toBe(6890150);
  });

  it('returns null for the feed-level <id> (no /t/ topic segment)', () => {
    expect(extractTopicId('tag:rto.feed,2000:/f/939')).toBeNull();
  });
});

describe('parseFeedEntry against the real live feed fixture (f/939)', () => {
  const parsed = parser.parse(xml) as { feed: { entry: unknown[] } };
  const rawEntries = parsed.feed.entry;

  it('has 50 entries in the fixture', () => {
    expect(rawEntries).toHaveLength(50);
  });

  it('parses every entry in the fixture through feedEntrySchema', () => {
    const results = rawEntries.map((raw) => parseFeedEntry(raw as Parameters<typeof parseFeedEntry>[0]));
    expect(results.every((r) => r !== null)).toBe(true);
    expect(results).toHaveLength(50);
  });

  it('extracts topic id, url, and title correctly for a known entry', () => {
    const raw = rawEntries.find((r) =>
      (r as { title: string }).title.startsWith('Большой куш. Бангкок 2 сезон: 5'),
    );
    const entry = parseFeedEntry(raw as Parameters<typeof parseFeedEntry>[0]);
    expect(entry?.topicId).toBe(6890150);
    expect(entry?.url).toBe('https://rutracker.org/forum/viewtopic.php?t=6890150');
    expect(entry?.rawTitle).toContain('Большой куш. Бангкок 2 сезон: 5 выпуск');
    expect(entry?.updatedAt).toBeInstanceOf(Date);
  });
});

describe('parseFeedEntry picks the topic link, not the magnet enclosure link', () => {
  // RuTracker's feed emits <link href="…viewtopic…"> AND <link rel="enclosure"
  // href="magnet:…">on every entry -- fast-xml-parser folds two same-named
  // sibling tags into an array once that happens, which used to break
  // extraction entirely (the whole array reached z.url() as `url` and failed
  // validation, silently dropping every real feed entry as "malformed").
  it('extracts the viewtopic href when link is an array (topic link before enclosure)', () => {
    const raw = parser.parse(
      `<entry>
        <id>tag:rto.feed,2026-08-29:/t/6901675</id>
        <link href="https://rutracker.org/forum/viewtopic.php?t=6901675"/>
        <link rel="enclosure" href="magnet:?xt=urn:btih:ABC" type="application/x-bittorrent"/>
        <title>Show</title>
        <updated>2026-08-29T21:16:26+00:00</updated>
      </entry>`,
    ).entry;
    const entry = parseFeedEntry(raw as Parameters<typeof parseFeedEntry>[0]);
    expect(entry?.url).toBe('https://rutracker.org/forum/viewtopic.php?t=6901675');
  });

  it('extracts the viewtopic href when link is an array (enclosure before topic link)', () => {
    const raw = parser.parse(
      `<entry>
        <id>tag:rto.feed,2026-08-29:/t/6901675</id>
        <link rel="enclosure" href="magnet:?xt=urn:btih:ABC" type="application/x-bittorrent"/>
        <link href="https://rutracker.org/forum/viewtopic.php?t=6901675"/>
        <title>Show</title>
        <updated>2026-08-29T21:16:26+00:00</updated>
      </entry>`,
    ).entry;
    const entry = parseFeedEntry(raw as Parameters<typeof parseFeedEntry>[0]);
    expect(entry?.url).toBe('https://rutracker.org/forum/viewtopic.php?t=6901675');
  });
});
