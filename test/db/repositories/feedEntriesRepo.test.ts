import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { hasTestDb, truncateAll } from '../testDb.js';
import { pool } from '../../../src/db/pool.js';
import {
  upsertFeedEntry,
  filterExistingTopicIds,
  listUnnotifiedEntries,
  markNotified,
  listFeedEntries,
  setTitleId,
} from '../../../src/db/repositories/feedEntriesRepo.js';

async function insertTitle(nameRu: string): Promise<string> {
  const result = await pool.query('insert into titles (name_ru) values ($1) returning id', [nameRu]);
  return result.rows[0].id;
}

describe.skipIf(!hasTestDb)('feedEntriesRepo', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('inserts a new feed entry', async () => {
    const titleId = await insertTitle('Большой куш');
    const record = await upsertFeedEntry({
      topicId: 1,
      titleId,
      rawTitle: 'Большой куш. Бангкок 2 сезон: 1 выпуск',
      url: 'https://rutracker.org/forum/viewtopic.php?t=1',
      lastUpdated: new Date('2026-01-01T00:00:00Z'),
    });
    expect(record.topicId).toBe(1);
    expect(record.titleId).toBe(titleId);
    expect(record.notifiedAt).toBeNull();
  });

  it('on conflict, refreshes title_id and raw_title -- not just last_updated', async () => {
    // Stored once unmatched (title_id null), as RUTRACKER_STORE_UNMATCHED
    // would produce before a matching title exists in the library.
    await upsertFeedEntry({
      topicId: 2,
      titleId: null,
      rawTitle: 'Некое шоу 1 выпуск',
      url: 'https://rutracker.org/forum/viewtopic.php?t=2',
      lastUpdated: new Date('2026-01-01T00:00:00Z'),
    });

    // A later ingest finds a match (the title got added to the library) and
    // the torrent got [Обновлено] -- title_id and raw_title must both move.
    const titleId = await insertTitle('Некое шоу');
    const updated = await upsertFeedEntry({
      topicId: 2,
      titleId,
      rawTitle: '[Обновлено] Некое шоу 1-2 выпуск',
      url: 'https://rutracker.org/forum/viewtopic.php?t=2',
      lastUpdated: new Date('2026-01-02T00:00:00Z'),
    });

    expect(updated.titleId).toBe(titleId);
    expect(updated.rawTitle).toBe('[Обновлено] Некое шоу 1-2 выпуск');
    expect(updated.lastUpdated.toISOString()).toBe('2026-01-02T00:00:00.000Z');

    const rows = await pool.query('select count(*) from feed_entries');
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it('on conflict, does not clobber an already-matched title_id with a different one', async () => {
    // Matched to title A on the first poll.
    const titleA = await insertTitle('Шоу А');
    await upsertFeedEntry({
      topicId: 5,
      titleId: titleA,
      rawTitle: 'Шоу 1 выпуск',
      url: 'https://rutracker.org/forum/viewtopic.php?t=5',
      lastUpdated: new Date('2026-01-01T00:00:00Z'),
    });

    // A later poll's matcher produces a *different* title for the same
    // topic (e.g. a near-duplicate title was added to the library and the
    // matcher now prefers it) -- the already-stored match must stick.
    const titleB = await insertTitle('Шоу Б');
    const updated = await upsertFeedEntry({
      topicId: 5,
      titleId: titleB,
      rawTitle: 'Шоу 1 выпуск',
      url: 'https://rutracker.org/forum/viewtopic.php?t=5',
      lastUpdated: new Date('2026-01-02T00:00:00Z'),
    });

    expect(updated.titleId).toBe(titleA);
  });

  it('a manual match (setTitleId) survives the next automatic poll', async () => {
    // Automatic matcher leaves it unmatched.
    await upsertFeedEntry({
      topicId: 6,
      titleId: null,
      rawTitle: 'Погоня 2 сезон: 3 выпуск',
      url: 'https://rutracker.org/forum/viewtopic.php?t=6',
      lastUpdated: new Date('2026-01-01T00:00:00Z'),
    });

    // A human manually matches it via the Feed tab's autocomplete picker.
    const manualTitle = await insertTitle('Погоня');
    await setTitleId(6, manualTitle);

    // The next poll re-runs the automatic matcher against the same raw
    // title -- still no automatic match (titleId: null) -- and re-upserts.
    // The manual match must not be reverted back to NULL.
    const repolled = await upsertFeedEntry({
      topicId: 6,
      titleId: null,
      rawTitle: 'Погоня 2 сезон: 3 выпуск',
      url: 'https://rutracker.org/forum/viewtopic.php?t=6',
      lastUpdated: new Date('2026-01-02T00:00:00Z'),
    });

    expect(repolled.titleId).toBe(manualTitle);
  });

  it('preserves first_seen across an on-conflict update', async () => {
    const first = await upsertFeedEntry({
      topicId: 3,
      titleId: null,
      rawTitle: 'Шоу',
      url: 'https://rutracker.org/forum/viewtopic.php?t=3',
      lastUpdated: new Date('2026-01-01T00:00:00Z'),
    });
    const second = await upsertFeedEntry({
      topicId: 3,
      titleId: null,
      rawTitle: 'Шоу',
      url: 'https://rutracker.org/forum/viewtopic.php?t=3',
      lastUpdated: new Date('2026-01-02T00:00:00Z'),
    });
    expect(second.firstSeen.toISOString()).toBe(first.firstSeen.toISOString());
  });

  it('filterExistingTopicIds reports only the topic ids already stored', async () => {
    await upsertFeedEntry({
      topicId: 10,
      titleId: null,
      rawTitle: 'Шоу А',
      url: 'https://rutracker.org/forum/viewtopic.php?t=10',
      lastUpdated: new Date(),
    });
    const existing = await filterExistingTopicIds([10, 20, 30]);
    expect(existing).toEqual(new Set([10]));
  });

  it('filterExistingTopicIds returns an empty set for an empty input without querying', async () => {
    expect(await filterExistingTopicIds([])).toEqual(new Set());
  });

  it('listUnnotifiedEntries only returns rows with notified_at null, and markNotified clears them', async () => {
    await upsertFeedEntry({
      topicId: 40,
      titleId: null,
      rawTitle: 'Шоу Б',
      url: 'https://rutracker.org/forum/viewtopic.php?t=40',
      lastUpdated: new Date(),
    });
    await upsertFeedEntry({
      topicId: 41,
      titleId: null,
      rawTitle: 'Шоу В',
      url: 'https://rutracker.org/forum/viewtopic.php?t=41',
      lastUpdated: new Date(),
    });

    const beforeNotify = await listUnnotifiedEntries();
    expect(beforeNotify.map((e) => e.topicId).sort()).toEqual([40, 41]);

    await markNotified([40]);

    const afterNotify = await listUnnotifiedEntries();
    expect(afterNotify.map((e) => e.topicId)).toEqual([41]);
  });

  it('listFeedEntries joins title_id to titles.name_ru and orders by last_updated desc', async () => {
    const titleId = await insertTitle('Большой куш');
    await upsertFeedEntry({
      topicId: 50,
      titleId,
      rawTitle: 'Большой куш. Бангкок 2 сезон: 1 выпуск',
      url: 'https://rutracker.org/forum/viewtopic.php?t=50',
      lastUpdated: new Date('2026-01-01T00:00:00Z'),
    });
    await upsertFeedEntry({
      topicId: 51,
      titleId,
      rawTitle: 'Большой куш. Бангкок 2 сезон: 2 выпуск',
      url: 'https://rutracker.org/forum/viewtopic.php?t=51',
      lastUpdated: new Date('2026-01-02T00:00:00Z'),
    });

    const entries = await listFeedEntries();
    expect(entries.map((e) => e.topicId)).toEqual([51, 50]);
    expect(entries[0]?.titleName).toBe('Большой куш');
  });

  it('listFeedEntries caps limit at 200 and applies offset', async () => {
    for (let i = 0; i < 3; i++) {
      await upsertFeedEntry({
        topicId: 100 + i,
        titleId: null,
        rawTitle: `Шоу ${i}`,
        url: `https://rutracker.org/forum/viewtopic.php?t=${100 + i}`,
        lastUpdated: new Date(2026, 0, i + 1),
      });
    }
    const capped = await listFeedEntries({ limit: 10_000 });
    expect(capped).toHaveLength(3);

    const paged = await listFeedEntries({ limit: 1, offset: 1 });
    expect(paged).toHaveLength(1);
    expect(paged[0]?.topicId).toBe(101);
  });

  it('setTitleId assigns a manual match to a previously-unmatched entry', async () => {
    await upsertFeedEntry({
      topicId: 200,
      titleId: null,
      rawTitle: 'Погоня 2 сезон: 3 выпуск',
      url: 'https://rutracker.org/forum/viewtopic.php?t=200',
      lastUpdated: new Date(),
    });
    const titleId = await insertTitle('Погоня');

    const updated = await setTitleId(200, titleId);
    expect(updated?.titleId).toBe(titleId);

    const reread = await listFeedEntries();
    expect(reread.find((e) => e.topicId === 200)?.titleId).toBe(titleId);
  });

  it('setTitleId returns null for a topic id that does not exist', async () => {
    const titleId = await insertTitle('Show');
    expect(await setTitleId(999_999, titleId)).toBeNull();
  });

  it('setTitleId returns null (not a thrown FK error) for a title id that does not exist', async () => {
    await upsertFeedEntry({
      topicId: 201,
      titleId: null,
      rawTitle: 'Show',
      url: 'https://rutracker.org/forum/viewtopic.php?t=201',
      lastUpdated: new Date(),
    });
    const result = await setTitleId(201, '00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });
});
