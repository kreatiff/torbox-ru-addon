import { describe, expect, it } from 'vitest';
import { proposeRule } from '../../src/resolve/proposeRule.js';
import type { TitleMatch } from '../../src/resolve/confidence.js';
import { stavkaNaLyubov } from '../fixtures/index.js';

function match(titleId: string): TitleMatch {
  return {
    titleId,
    nameRu: 'Test Title',
    nameEn: null,
    seasons: [{ season: 2, episode_count: 10, episodes: [] }],
  };
}

describe('proposeRule', () => {
  it('proposes a parsed rule for the Ставка на любовь fixture', async () => {
    const fixture = await stavkaNaLyubov();
    const files = fixture.files.map((f) => ({
      id: f.id,
      rawPath: f.rawPath,
      isVideo: f.isVideo,
      size: f.size,
    }));
    const { proposal, tier, gate } = proposeRule(
      { hash: fixture.hash, rawNameAtIngest: fixture.torrentName },
      files,
      match('stavka-title'),
    );

    expect(proposal.torrentHash).toBe(fixture.hash);
    expect(proposal.titleId).toBe('stavka-title');
    expect(proposal.season).toBe(2);
    expect(proposal.numbering).toBe('parsed');
    expect(proposal.startEpisode).toBe(1);
    expect(proposal.source).toBe('auto');
    expect(proposal.proposalReason).toBeTruthy();
    expect(proposal.torrentName).toBe(fixture.torrentName);
    expect(tier).toBe('high');
    expect(gate).toBeNull();
  });

  it('falls back to season 1 when the cascade does not extract a season', () => {
    const { proposal } = proposeRule(
      { hash: 'h2', rawNameAtIngest: 'My Show 1 серия' },
      [{ id: 1, rawPath: 'my show.mp4', isVideo: true }],
      {
        titleId: 't1',
        nameRu: 'My Show',
        nameEn: null,
        seasons: [{ season: 1, episode_count: 1, episodes: [] }],
      },
    );

    expect(proposal.season).toBe(1);
  });

  it('forces the title gate (queue) when no title match was found, regardless of how well episodes score', async () => {
    // Same fixture as the first test -- would otherwise score 'high' -- but
    // with titleMatch: null, simulating resolveTitleMatch finding nothing.
    // Regression test for a bug where proposeRule hardcoded
    // hasConfidentTitleMatch to true, so an unmatched show could still reach
    // 'high' and auto-commit against the wrong (or no) show.
    const fixture = await stavkaNaLyubov();
    const files = fixture.files.map((f) => ({
      id: f.id,
      rawPath: f.rawPath,
      isVideo: f.isVideo,
      size: f.size,
    }));
    const { proposal, tier, gate } = proposeRule(
      { hash: fixture.hash, rawNameAtIngest: fixture.torrentName },
      files,
      null,
    );

    expect(tier).toBe('queue');
    expect(gate).toBe('title');
    expect(proposal.titleId).toBeNull();
  });
});
