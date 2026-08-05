import { describe, expect, it } from 'vitest';
import { proposeRule } from '../../src/resolve/proposeRule.js';
import type { TitleMatch } from '../../src/resolve/confidence.js';
import type { LlmExtraction } from '../../src/llm/opencodeZen.js';
import { stavkaNaLyubov } from '../fixtures/index.js';

function at<T>(arr: T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`test fixture missing index ${index}`);
  }
  return value;
}

function match(titleId: string, season = 2, episodes: number[] = []): TitleMatch {
  return {
    titleId,
    nameRu: 'Test Title',
    nameEn: null,
    seasons: [
      {
        season,
        episode_count: episodes.length,
        episodes: episodes.map((episode) => ({ episode, air_date: null })),
      },
    ],
  };
}

async function stavkaLlmExtraction(overrides: Partial<LlmExtraction> = {}): Promise<LlmExtraction> {
  const fixture = await stavkaNaLyubov();
  return {
    title: 'Ставка на любовь',
    titleEn: null,
    year: 2026,
    season: 2,
    files: fixture.files.map((f, index) => ({ fileId: f.id, episode: index + 1 })),
    confident: true,
    reasoning: 'Every file has an explicit episode number in the folder listing.',
    ...overrides,
  };
}

describe('proposeRule', () => {
  it('commits when the LLM is confident, title resolved, and episodes agree with provider data', async () => {
    const fixture = await stavkaNaLyubov();
    const files = fixture.files.map((f) => ({ id: f.id, rawPath: f.rawPath, isVideo: f.isVideo, size: f.size }));
    const llm = await stavkaLlmExtraction();

    const { proposal, tier } = proposeRule(
      { hash: fixture.hash, rawNameAtIngest: fixture.torrentName },
      files,
      match('stavka-title', 2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      llm,
    );

    expect(tier).toBe('commit');
    expect(proposal.titleId).toBe('stavka-title');
    expect(proposal.season).toBe(2);
    expect(proposal.numbering).toBe('manual');
    expect(proposal.source).toBe('auto');
    expect(proposal.confidence).toBeGreaterThanOrEqual(0.45);
    expect(proposal.exceptions[String(at(files, 0).id)]).toEqual({ season: 2, episode: 1 });
    expect(proposal.exceptions[String(at(files, 9).id)]).toEqual({ season: 2, episode: 10 });
  });

  it('queues when LLM extraction is unavailable (no API key / failed call)', () => {
    const { proposal, tier } = proposeRule(
      { hash: 'h1', rawNameAtIngest: 'Some Show' },
      [{ id: 1, rawPath: 'some show.mp4', isVideo: true }],
      null,
      null,
    );

    expect(tier).toBe('queue');
    expect(proposal.titleId).toBeNull();
    expect(proposal.confidence).toBeLessThan(0.45);
    expect(proposal.proposalReason).toContain('LLM extraction unavailable');
  });

  it('queues when the LLM ran but no title match was found, regardless of episode confidence', async () => {
    const fixture = await stavkaNaLyubov();
    const files = fixture.files.map((f) => ({ id: f.id, rawPath: f.rawPath, isVideo: f.isVideo, size: f.size }));
    const llm = await stavkaLlmExtraction();

    const { proposal, tier } = proposeRule(
      { hash: fixture.hash, rawNameAtIngest: fixture.torrentName },
      files,
      null,
      llm,
    );

    expect(tier).toBe('queue');
    expect(proposal.titleId).toBeNull();
    expect(proposal.proposalReason).toContain('no confident title match');
  });

  it('queues when the LLM reports itself not confident', async () => {
    const fixture = await stavkaNaLyubov();
    const files = fixture.files.map((f) => ({ id: f.id, rawPath: f.rawPath, isVideo: f.isVideo, size: f.size }));
    const llm = await stavkaLlmExtraction({ confident: false, reasoning: 'Not sure about episode 7.' });

    const { proposal, tier } = proposeRule(
      { hash: fixture.hash, rawNameAtIngest: fixture.torrentName },
      files,
      match('stavka-title', 2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      llm,
    );

    expect(tier).toBe('queue');
    expect(proposal.proposalReason).toContain('Not sure about episode 7');
  });

  it('queues when the LLM omits a video file from its response', async () => {
    const fixture = await stavkaNaLyubov();
    const files = fixture.files.map((f) => ({ id: f.id, rawPath: f.rawPath, isVideo: f.isVideo, size: f.size }));
    const llm = await stavkaLlmExtraction();
    llm.files = llm.files.slice(0, -1); // drop the last file's assignment

    const { proposal, tier } = proposeRule(
      { hash: fixture.hash, rawNameAtIngest: fixture.torrentName },
      files,
      match('stavka-title', 2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      llm,
    );

    expect(tier).toBe('queue');
    expect(proposal.proposalReason).toContain('did not cover every video file');
  });

  it('queues when an LLM-assigned episode falls outside the known provider season list', async () => {
    const fixture = await stavkaNaLyubov();
    const files = fixture.files.map((f) => ({ id: f.id, rawPath: f.rawPath, isVideo: f.isVideo, size: f.size }));
    const llm = await stavkaLlmExtraction();
    llm.files[0] = { fileId: at(files, 0).id, episode: 99 };

    const { proposal, tier } = proposeRule(
      { hash: fixture.hash, rawNameAtIngest: fixture.torrentName },
      files,
      match('stavka-title', 2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      llm,
    );

    expect(tier).toBe('queue');
    expect(proposal.proposalReason).toContain('outside the known season');
  });

  it('marks a file as ignored (trailer/sample) when the LLM assigns it a null episode', async () => {
    const fixture = await stavkaNaLyubov();
    const files = fixture.files.map((f) => ({ id: f.id, rawPath: f.rawPath, isVideo: f.isVideo, size: f.size }));
    const llm = await stavkaLlmExtraction();
    llm.files[0] = { fileId: at(files, 0).id, episode: null };

    const { proposal } = proposeRule(
      { hash: fixture.hash, rawNameAtIngest: fixture.torrentName },
      files,
      match('stavka-title', 2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      llm,
    );

    expect(proposal.exceptions[String(at(files, 0).id)]).toBe('ignore');
  });

  it('trusts the LLM season/episode numbers when no provider data is cached (no false negative)', async () => {
    const fixture = await stavkaNaLyubov();
    const files = fixture.files.map((f) => ({ id: f.id, rawPath: f.rawPath, isVideo: f.isVideo, size: f.size }));
    const llm = await stavkaLlmExtraction();
    const titleMatchNoProviderData: TitleMatch = {
      titleId: 'stavka-title',
      nameRu: 'Test Title',
      nameEn: null,
      seasons: [],
    };

    const { tier } = proposeRule(
      { hash: fixture.hash, rawNameAtIngest: fixture.torrentName },
      files,
      titleMatchNoProviderData,
      llm,
    );

    expect(tier).toBe('commit');
  });
});
