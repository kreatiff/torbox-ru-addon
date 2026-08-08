import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { hasTestDb, truncateAll } from '../testDb.js';
import { pool } from '../../../src/db/pool.js';
import {
  listMappingsForRule,
  replaceMappingsForRule,
  listMappedEpisodeKeys,
} from '../../../src/db/repositories/mappingsRepo.js';
import type { Mapping } from '../../../src/resolve/types.js';

async function seed(): Promise<{ titleId: string; ruleId: string; fileIds: number[] }> {
  const title = await pool.query(`insert into titles (name_ru) values ('Show') returning id`);
  const titleId = title.rows[0].id;
  await pool.query(
    `insert into torrents (hash, torbox_id, raw_name_at_ingest, last_seen) values ('h1', 1, 'Show', now())`,
  );
  const rule = await pool.query(
    `insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source)
     values ('h1', $1, 1, 'sequential', 'natural', 1, 1.0, 'manual') returning id`,
    [titleId],
  );
  const files = await pool.query(
    `insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
     values ('h1', 1, 'a.mp4', 1, true), ('h1', 2, 'b.mp4', 1, true)
     returning id`,
  );
  return { titleId, ruleId: rule.rows[0].id, fileIds: files.rows.map((r) => r.id) };
}

describe.skipIf(!hasTestDb)('mappingsRepo', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('replaceMappingsForRule inserts, then fully replaces on a second call', async () => {
    const { titleId, ruleId, fileIds } = await seed();
    const [file1, file2] = fileIds as [number, number];

    const first: Mapping[] = [
      { fileId: file1, titleId, season: 1, episode: 1, ruleId },
      { fileId: file2, titleId, season: 1, episode: 2, ruleId },
    ];
    await replaceMappingsForRule(ruleId, first);
    expect(await listMappingsForRule(ruleId)).toEqual(first);

    // A corrected rule (e.g. startEpisode changed) should fully replace, not merge.
    const corrected: Mapping[] = [{ fileId: file1, titleId, season: 1, episode: 5, ruleId }];
    await replaceMappingsForRule(ruleId, corrected);
    expect(await listMappingsForRule(ruleId)).toEqual(corrected);
  });

  it('replacing with an empty array clears existing mappings for the rule', async () => {
    const { titleId, ruleId, fileIds } = await seed();
    const [file1] = fileIds as [number, number];
    await replaceMappingsForRule(ruleId, [
      { fileId: file1, titleId, season: 1, episode: 1, ruleId },
    ]);
    await replaceMappingsForRule(ruleId, []);
    expect(await listMappingsForRule(ruleId)).toEqual([]);
  });

  it('listMappedEpisodeKeys returns a key per distinct (title, season, episode), scoped to the given title ids', async () => {
    const { titleId, ruleId, fileIds } = await seed();
    const [file1, file2] = fileIds as [number, number];
    await replaceMappingsForRule(ruleId, [
      { fileId: file1, titleId, season: 2, episode: 5, ruleId },
      { fileId: file2, titleId, season: 2, episode: 6, ruleId },
    ]);

    const keys = await listMappedEpisodeKeys([titleId]);
    expect(keys).toEqual(new Set([`${titleId}:2:5`, `${titleId}:2:6`]));

    const otherTitleId = '00000000-0000-0000-0000-000000000000';
    expect(await listMappedEpisodeKeys([otherTitleId])).toEqual(new Set());
  });

  it('listMappedEpisodeKeys returns an empty set for an empty input without querying', async () => {
    expect(await listMappedEpisodeKeys([])).toEqual(new Set());
  });
});
