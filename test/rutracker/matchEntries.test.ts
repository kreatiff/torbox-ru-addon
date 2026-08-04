import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { describe, it, expect } from 'vitest';
import { matchEntries } from '../../src/rutracker/matchEntries.js';
import { parseFeedEntry, type FeedEntry } from '../../src/rutracker/feedEntry.js';
import type { Title } from '../../src/db/repositories/titlesRepo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const xml = readFileSync(path.join(__dirname, '../fixtures/rutracker-f939.xml'), 'utf-8');
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function title(nameRu: string, overrides: Partial<Title> = {}): Title {
  return {
    id: nameRu,
    imdbId: null,
    tvdbId: null,
    tmdbId: null,
    nameRu,
    nameEn: null,
    year: null,
    aliases: [],
    posterUrl: null,
    ...overrides,
  };
}

function fixtureEntries(): FeedEntry[] {
  const parsed = parser.parse(xml) as { feed: { entry: unknown[] } };
  return parsed.feed.entry
    .map((raw) => parseFeedEntry(raw as Parameters<typeof parseFeedEntry>[0]))
    .filter((e): e is FeedEntry => e !== null);
}

function entry(topicId: number, rawTitle: string): FeedEntry {
  return {
    topicId,
    url: `https://rutracker.org/forum/viewtopic.php?t=${topicId}`,
    rawTitle,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('matchEntries against the real live feed fixture (f/939)', () => {
  it('matches all five "Большой куш. Бангкок" entries and nothing else, against just that one title', () => {
    const bolshoyKush = title('Большой куш');

    const matched = matchEntries(fixtureEntries(), [bolshoyKush]);

    expect(matched).toHaveLength(5);
    expect(matched.every((m) => m.title === bolshoyKush)).toBe(true);
    expect(matched.every((m) => m.season === 2)).toBe(true);
    expect(new Set(matched.map((m) => m.entry.topicId))).toEqual(
      new Set([6890150, 6887296, 6884263, 6881585, 6881562]),
    );
  });

  it('routes each of several titles to only its own entries when the library has more than one show', () => {
    // Unlike the decoy-title case below, these three shows are genuinely
    // present in the fixture with their own real episodes -- this checks
    // matchEntries doesn't cross-assign one show's entries to another.
    const bolshoyKush = title('Большой куш');
    const pogonya = title('Погоня');
    const igra = title('Игра вслепую');

    const matched = matchEntries(fixtureEntries(), [bolshoyKush, pogonya, igra]);

    const byTitle = new Map<Title, number>();
    for (const m of matched) {
      byTitle.set(m.title, (byTitle.get(m.title) ?? 0) + 1);
    }
    expect(byTitle.get(bolshoyKush)).toBe(5);
    expect(byTitle.get(pogonya)).toBe(3);
    expect(byTitle.get(igra)).toBe(6);
  });

  it('returns nothing when no title in the library matches any entry', () => {
    const unrelated = title('Совершенно другое шоу');
    expect(matchEntries(fixtureEntries(), [unrelated])).toEqual([]);
  });
});

describe('matchEntries word-boundary matching (synthetic cases)', () => {
  it('does not match a title name that only occurs as a substring of a longer word', () => {
    // "Дом" must not match inside "Домработница" -- plain substring
    // containment would false-positive here.
    const domEntry = entry(1, 'Домработница 3 сезон: 1 выпуск [2026, реалити]');
    const dom = title('Дом');
    expect(matchEntries([domEntry], [dom])).toEqual([]);
  });

  it('still matches when the title name is immediately followed by punctuation, not whitespace', () => {
    // "Большой куш." (period, no space) -- the season-suffix case the plan
    // calls out by name.
    const bkEntry = entry(2, 'Большой куш. Бангкок 2 сезон: 5 выпуск [2026]');
    const bolshoyKush = title('Большой куш');
    expect(matchEntries([bkEntry], [bolshoyKush])).toHaveLength(1);
  });

  it('matches at the very start of the cleaned prefix (no leading boundary character needed)', () => {
    const e = entry(3, 'Игра вслепую. 1 сезон: 6 выпуск [2026]');
    const igra = title('Игра вслепую');
    expect(matchEntries([e], [igra])).toHaveLength(1);
  });
});
