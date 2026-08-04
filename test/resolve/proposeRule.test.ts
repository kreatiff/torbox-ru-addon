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
    }));
    const rule = proposeRule(
      { hash: fixture.hash, rawNameAtIngest: fixture.torrentName },
      files,
      match('stavka-title'),
    );

    expect(rule.torrentHash).toBe(fixture.hash);
    expect(rule.titleId).toBe('stavka-title');
    expect(rule.season).toBe(2);
    expect(rule.numbering).toBe('parsed');
    expect(rule.startEpisode).toBe(1);
    expect(rule.source).toBe('auto');
    expect(rule.proposalReason).toBeTruthy();
    expect(rule.torrentName).toBe(fixture.torrentName);
  });

  it('falls back to season 1 when the cascade does not extract a season', () => {
    const rule = proposeRule(
      { hash: 'h2', rawNameAtIngest: 'My Show 1 серия' },
      [{ id: 1, rawPath: 'my show.mp4', isVideo: true }],
      {
        titleId: 't1',
        nameRu: 'My Show',
        nameEn: null,
        seasons: [{ season: 1, episode_count: 1, episodes: [] }],
      },
    );

    expect(rule.season).toBe(1);
  });
});
