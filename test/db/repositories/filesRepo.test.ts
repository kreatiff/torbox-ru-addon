import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { hasTestDb, truncateAll } from '../testDb.js';
import { pool } from '../../../src/db/pool.js';
import { upsertTorrent } from '../../../src/db/repositories/torrentsRepo.js';
import { upsertFiles } from '../../../src/db/repositories/filesRepo.js';

describe.skipIf(!hasTestDb)('filesRepo', () => {
  beforeEach(async () => {
    await truncateAll();
    await upsertTorrent({
      hash: 'abc123',
      torboxId: 1,
      name: 'Some Show',
      totalSize: null,
      cachedAt: null,
      addedAt: null,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('bulk inserts files for a torrent', async () => {
    const files = await upsertFiles([
      {
        torrentHash: 'abc123',
        torboxFileId: 1,
        rawPath: '01 выпуск.mp4',
        size: 5_000_000_000,
        isVideo: true,
      },
      {
        torrentHash: 'abc123',
        torboxFileId: 2,
        rawPath: '02 выпуск.mp4',
        size: 5_100_000_000,
        isVideo: true,
      },
    ]);
    expect(files).toHaveLength(2);
    expect(files[0]?.rawPath).toBe('01 выпуск.mp4');
    expect(files[0]?.mountPath).toBeNull();
  });

  it('updates raw_path/size/is_video on conflict but preserves mount_path', async () => {
    await upsertFiles([
      { torrentHash: 'abc123', torboxFileId: 1, rawPath: 'old-path.mp4', size: 100, isVideo: true },
    ]);
    await pool.query(
      `update files set mount_path = '/mnt/torbox/real/path.mp4' where torrent_hash = 'abc123' and torbox_file_id = 1`,
    );

    const [refreshed] = await upsertFiles([
      {
        torrentHash: 'abc123',
        torboxFileId: 1,
        rawPath: 'renamed-path.mp4',
        size: 200,
        isVideo: true,
      },
    ]);

    expect(refreshed?.rawPath).toBe('renamed-path.mp4');
    expect(refreshed?.size).toBe(200);
    expect(refreshed?.mountPath).toBe('/mnt/torbox/real/path.mp4');
  });

  it('returns an empty array without querying when given no files', async () => {
    const files = await upsertFiles([]);
    expect(files).toEqual([]);
  });
});
