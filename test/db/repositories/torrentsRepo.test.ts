import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { hasTestDb, truncateAll } from '../testDb.js';
import { pool } from '../../../src/db/pool.js';
import {
  listKnownHashes,
  markAbsentGone,
  upsertTorrent,
} from '../../../src/db/repositories/torrentsRepo.js';

describe.skipIf(!hasTestDb)('torrentsRepo', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('snapshots raw_name_at_ingest on first insert and never updates it again', async () => {
    const first = await upsertTorrent({
      hash: 'abc123',
      torboxId: 1,
      name: 'Original Name',
      totalSize: 1000,
      cachedAt: null,
      addedAt: null,
    });
    expect(first.rawNameAtIngest).toBe('Original Name');
    expect(first.currentName).toBe('Original Name');
    expect(first.status).toBe('active');

    const second = await upsertTorrent({
      hash: 'abc123',
      torboxId: 1,
      name: 'Renamed By Uploader',
      totalSize: 2000,
      cachedAt: null,
      addedAt: null,
    });

    // raw_name_at_ingest is immutable; current_name and total_size drift.
    expect(second.rawNameAtIngest).toBe('Original Name');
    expect(second.currentName).toBe('Renamed By Uploader');
    expect(second.totalSize).toBe(2000);
    expect(second.firstSeen.getTime()).toBe(first.firstSeen.getTime());
  });

  it('flips a gone torrent back to active on re-upsert', async () => {
    await upsertTorrent({
      hash: 'abc123',
      torboxId: 1,
      name: 'Some Show',
      totalSize: null,
      cachedAt: null,
      addedAt: null,
    });
    await markAbsentGone([]); // no-op guard, see below
    await markAbsentGone(['some-other-hash']);
    const reupserted = await upsertTorrent({
      hash: 'abc123',
      torboxId: 1,
      name: 'Some Show',
      totalSize: null,
      cachedAt: null,
      addedAt: null,
    });
    expect(reupserted.status).toBe('active');
  });

  it('markAbsentGone marks only hashes missing from the present list', async () => {
    await upsertTorrent({
      hash: 'stays',
      torboxId: 1,
      name: 'Stays',
      totalSize: null,
      cachedAt: null,
      addedAt: null,
    });
    await upsertTorrent({
      hash: 'disappears',
      torboxId: 2,
      name: 'Disappears',
      totalSize: null,
      cachedAt: null,
      addedAt: null,
    });

    const affected = await markAbsentGone(['stays']);
    expect(affected).toBe(1);

    const hashes = await listKnownHashes();
    expect(hashes).toEqual(new Set(['stays', 'disappears']));
  });

  it('markAbsentGone is a no-op on an empty present-list, not a wipe', async () => {
    await upsertTorrent({
      hash: 'abc123',
      torboxId: 1,
      name: 'Some Show',
      totalSize: null,
      cachedAt: null,
      addedAt: null,
    });
    const affected = await markAbsentGone([]);
    expect(affected).toBe(0);
  });

  it('listKnownHashes returns hashes regardless of status', async () => {
    await upsertTorrent({
      hash: 'abc123',
      torboxId: 1,
      name: 'Some Show',
      totalSize: null,
      cachedAt: null,
      addedAt: null,
    });
    await markAbsentGone(['unrelated']);
    const hashes = await listKnownHashes();
    expect(hashes.has('abc123')).toBe(true);
  });
});
