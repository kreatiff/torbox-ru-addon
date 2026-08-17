import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { hasTestDb, truncateAll } from '../testDb.js';
import { pool } from '../../../src/db/pool.js';
import {
  getTorrentByHash,
  listKnownHashes,
  markAbsentGone,
  markFilesFetched,
  upsertTorrent,
  deleteTorrent,
  deleteGoneTorrents,
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

    await markFilesFetched(['stays', 'disappears']);
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

  it('listKnownHashes excludes a torrent whose files were never fetched, regardless of status', async () => {
    await upsertTorrent({
      hash: 'abc123',
      torboxId: 1,
      name: 'Some Show',
      totalSize: null,
      cachedAt: null,
      addedAt: null,
    });
    await markAbsentGone(['unrelated']);

    // Row exists (e.g. seeded early by downloadFeedEntry's preMapIfPossible),
    // but files_fetched_at is still null -- this hash must stay eligible for
    // a files fetch, not look "known" just because a torrents row exists.
    let hashes = await listKnownHashes();
    expect(hashes.has('abc123')).toBe(false);

    await markFilesFetched(['abc123']);
    hashes = await listKnownHashes();
    expect(hashes.has('abc123')).toBe(true);
  });

  it('markFilesFetched is a no-op on an empty hash list', async () => {
    await expect(markFilesFetched([])).resolves.toBeUndefined();
  });

  it('getTorrentByHash returns the torrent, or null when unknown', async () => {
    await upsertTorrent({
      hash: 'abc123',
      torboxId: 1,
      name: 'Some Show',
      totalSize: null,
      cachedAt: null,
      addedAt: null,
    });
    const found = await getTorrentByHash('abc123');
    expect(found?.hash).toBe('abc123');
    expect(found?.rawNameAtIngest).toBe('Some Show');

    const missing = await getTorrentByHash('does-not-exist');
    expect(missing).toBeNull();
  });

  it('deleteTorrent refuses to delete an active torrent', async () => {
    await upsertTorrent({
      hash: 'abc123',
      torboxId: 1,
      name: 'Some Show',
      totalSize: null,
      cachedAt: null,
      addedAt: null,
    });
    const deleted = await deleteTorrent('abc123');
    expect(deleted).toBe(false);
    expect(await getTorrentByHash('abc123')).not.toBeNull();
  });

  it('deleteTorrent deletes a gone torrent and cascades to its files/rules/mappings', async () => {
    await upsertTorrent({
      hash: 'abc123',
      torboxId: 1,
      name: 'Some Show',
      totalSize: null,
      cachedAt: null,
      addedAt: null,
    });
    await markAbsentGone(['unrelated']);

    const fileResult = await pool.query(
      `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
       values ($1, 1, 'S01E01.mkv', 100, true) returning id`,
      ['abc123'],
    );
    const fileId = fileResult.rows[0].id;

    const deleted = await deleteTorrent('abc123');
    expect(deleted).toBe(true);
    expect(await getTorrentByHash('abc123')).toBeNull();

    const remainingFiles = await pool.query('select id from files where id = $1', [fileId]);
    expect(remainingFiles.rows).toHaveLength(0);
  });

  it('deleteTorrent returns false for an unknown hash', async () => {
    expect(await deleteTorrent('does-not-exist')).toBe(false);
  });

  it('deleteGoneTorrents bulk-deletes only gone torrents and returns the count', async () => {
    await upsertTorrent({
      hash: 'stays',
      torboxId: 1,
      name: 'Stays',
      totalSize: null,
      cachedAt: null,
      addedAt: null,
    });
    await upsertTorrent({
      hash: 'goes-1',
      torboxId: 2,
      name: 'Goes 1',
      totalSize: null,
      cachedAt: null,
      addedAt: null,
    });
    await upsertTorrent({
      hash: 'goes-2',
      torboxId: 3,
      name: 'Goes 2',
      totalSize: null,
      cachedAt: null,
      addedAt: null,
    });
    await markAbsentGone(['stays']);
    await markFilesFetched(['stays', 'goes-1', 'goes-2']);

    const deletedCount = await deleteGoneTorrents();
    expect(deletedCount).toBe(2);

    const hashes = await listKnownHashes();
    expect(hashes).toEqual(new Set(['stays']));
  });
});
