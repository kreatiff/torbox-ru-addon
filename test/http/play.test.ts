import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { hasTestDb, truncateAll } from '../db/testDb.js';
import { pool } from '../../src/db/pool.js';
import { config } from '../../src/config.js';
import { build } from '../../src/http/server.js';
import { getPlaybackUrl } from '../../src/torbox/client.js';

const MOCK_PLAYBACK_URL = 'https://cdn.torbox.app/signed/abc123/movie.mp4';

// No real TorBox call in tests (docs/milestones.md's stated plan for this
// milestone): the redirect/play_log logic is what's under test here, not
// TorBox's actual requestdl behaviour.
vi.mock('../../src/torbox/client.js', () => ({
  getPlaybackUrl: vi.fn(async () => MOCK_PLAYBACK_URL),
}));

async function seedFile(): Promise<number> {
  await pool.query(
    `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen)
     values ('h1', 1001, 'Show', now())`,
  );
  const files = await pool.query(
    `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
     values ('h1', 42, '01.mp4', 123, true) returning id`,
  );
  return files.rows[0].id as number;
}

describe.skipIf(!hasTestDb)('play route (real Postgres, mocked TorBox)', () => {
  beforeEach(async () => {
    await truncateAll();
    vi.mocked(getPlaybackUrl).mockClear();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("redirects to whatever getPlaybackUrl returns, called with TorBox's ids (not our internal ones)", async () => {
    const fileId = await seedFile();
    const app = await build();
    const response = await app.inject({
      method: 'GET',
      url: `/${config.addonToken}/play/${fileId}`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(MOCK_PLAYBACK_URL);
    expect(getPlaybackUrl).toHaveBeenCalledWith(1001, 42);
    await app.close();
  });

  it('LOCKED (§5.5): never leaks TORBOX_API_KEY anywhere in the response', async () => {
    const fileId = await seedFile();
    const app = await build();
    const response = await app.inject({
      method: 'GET',
      url: `/${config.addonToken}/play/${fileId}`,
    });
    const raw = JSON.stringify(response.headers) + response.body;
    expect(raw).not.toContain(config.torboxApiKey);
    await app.close();
  });

  it('writes a play_log row for the file (fire-and-forget, so poll for it)', async () => {
    const fileId = await seedFile();
    const app = await build();
    await app.inject({ method: 'GET', url: `/${config.addonToken}/play/${fileId}` });
    await app.close();

    await vi.waitFor(async () => {
      const log = await pool.query('select file_id from play_log where file_id = $1', [fileId]);
      expect(log.rows).toHaveLength(1);
    });
  });

  it('404s for a file id that does not exist', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'GET',
      url: `/${config.addonToken}/play/999999`,
    });
    expect(response.statusCode).toBe(404);
    expect(getPlaybackUrl).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a non-numeric fileId with 404 rather than an error', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'GET',
      url: `/${config.addonToken}/play/not-a-number`,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
