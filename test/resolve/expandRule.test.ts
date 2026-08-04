import { describe, it, expect } from 'vitest';
import { expandRule } from '../../src/resolve/expandRule.js';
import type { Rule, RuleFile } from '../../src/resolve/types.js';

const baseRule: Rule = {
  id: 'rule-1',
  torrentHash: 'hash-1',
  titleId: 'title-1',
  season: 3,
  numbering: 'sequential',
  sort: 'natural',
  startEpisode: 1,
  absoluteOffset: null,
  exceptions: {},
  confidence: 1,
  source: 'manual',
  proposalReason: null,
  torrentName: null,
};

function file(id: number, path: string, isVideo = true): RuleFile {
  return { id, path, isVideo };
}

describe('expandRule', () => {
  describe('sequential', () => {
    it('numbers natural-sorted files starting at startEpisode', () => {
      const files = [file(1, '01 выпуск.mp4'), file(2, '02 выпуск.mp4'), file(3, '03 выпуск.mp4')];
      const mappings = expandRule(baseRule, files);
      expect(mappings).toEqual([
        { fileId: 1, titleId: 'title-1', season: 3, episode: 1, ruleId: 'rule-1' },
        { fileId: 2, titleId: 'title-1', season: 3, episode: 2, ruleId: 'rule-1' },
        { fileId: 3, titleId: 'title-1', season: 3, episode: 3, ruleId: 'rule-1' },
      ]);
    });

    it('respects a non-default startEpisode', () => {
      const rule: Rule = { ...baseRule, startEpisode: 5 };
      const mappings = expandRule(rule, [file(1, 'a.mp4'), file(2, 'b.mp4')]);
      expect(mappings.map((m) => m.episode)).toEqual([5, 6]);
    });

    // §7 pathological case: lexical-vs-natural sort. Plain lexical order
    // would put "10 выпуск.mp4" right after "1 выпуск.mp4", shifting every
    // episode from 2 onward.
    it('natural sort orders 1, 2, 10 correctly; path sort does not', () => {
      const files = [file(10, '10.mp4'), file(1, '1.mp4'), file(2, '2.mp4')];

      const naturalMappings = expandRule({ ...baseRule, sort: 'natural' }, files);
      expect(naturalMappings.map((m) => m.fileId)).toEqual([1, 2, 10]); // by fileId asc (output order)
      expect(naturalMappings.find((m) => m.fileId === 1)?.episode).toBe(1);
      expect(naturalMappings.find((m) => m.fileId === 2)?.episode).toBe(2);
      expect(naturalMappings.find((m) => m.fileId === 10)?.episode).toBe(3);

      const pathMappings = expandRule({ ...baseRule, sort: 'path' }, files);
      // lexical order: "1.mp4", "10.mp4", "2.mp4" -> episodes 1, 2, 3 respectively
      expect(pathMappings.find((m) => m.fileId === 1)?.episode).toBe(1);
      expect(pathMappings.find((m) => m.fileId === 10)?.episode).toBe(2);
      expect(pathMappings.find((m) => m.fileId === 2)?.episode).toBe(3);
    });
  });

  describe('continuous', () => {
    // §7 pathological case: continuous numbering across a season boundary.
    // Season 1 had 12 episodes; this torrent's files are absolute 13-15,
    // i.e. season 2 episodes 1-3.
    it('subtracts absoluteOffset from a startEpisode treated as absolute', () => {
      const rule: Rule = {
        ...baseRule,
        season: 2,
        numbering: 'continuous',
        startEpisode: 13,
        absoluteOffset: 12,
      };
      const files = [file(1, '13.mp4'), file(2, '14.mp4'), file(3, '15.mp4')];
      const mappings = expandRule(rule, files);
      expect(
        mappings.map((m) => ({ fileId: m.fileId, season: m.season, episode: m.episode })),
      ).toEqual([
        { fileId: 1, season: 2, episode: 1 },
        { fileId: 2, season: 2, episode: 2 },
        { fileId: 3, season: 2, episode: 3 },
      ]);
    });

    it('throws when absoluteOffset is not set', () => {
      const rule: Rule = { ...baseRule, numbering: 'continuous', absoluteOffset: null };
      expect(() => expandRule(rule, [file(1, 'a.mp4')])).toThrow(/absoluteOffset/);
    });
  });

  describe('manual', () => {
    it('maps only files with an explicit exception; everything else is dropped', () => {
      const rule: Rule = {
        ...baseRule,
        numbering: 'manual',
        exceptions: {
          '1': { season: 3, episode: 1 },
          '3': { season: 3, episode: 2 },
        },
      };
      const files = [file(1, 'a.mp4'), file(2, 'b.mp4'), file(3, 'c.mp4')];
      const mappings = expandRule(rule, files);
      expect(mappings).toEqual([
        { fileId: 1, titleId: 'title-1', season: 3, episode: 1, ruleId: 'rule-1' },
        { fileId: 3, titleId: 'title-1', season: 3, episode: 2, ruleId: 'rule-1' },
      ]);
    });
  });

  describe('parsed', () => {
    it('parses episodes from the torrent name and file paths', () => {
      const rule: Rule = {
        ...baseRule,
        numbering: 'parsed',
        torrentName: 'My Show 1 сезон 2 из 2 выпуска',
      };
      const files = [file(1, '01 выпуск.mp4'), file(2, '02 выпуск.mp4')];
      const mappings = expandRule(rule, files);
      expect(mappings).toEqual([
        { fileId: 1, titleId: 'title-1', season: 1, episode: 1, ruleId: 'rule-1' },
        { fileId: 2, titleId: 'title-1', season: 1, episode: 2, ruleId: 'rule-1' },
      ]);
    });

    it('throws when torrentName is missing for parsed mode', () => {
      const rule: Rule = { ...baseRule, numbering: 'parsed' };
      expect(() => expandRule(rule, [file(1, 'a.mp4')])).toThrow(/torrentName/);
    });
  });

  describe('exceptions (all modes)', () => {
    // §7 pathological case: a torrent with a trailer file. Excluding it
    // must not leave a gap in the remaining episodes' numbering.
    it("'ignore' excludes a file without shifting episodes after it", () => {
      const rule: Rule = {
        ...baseRule,
        exceptions: { '2': 'ignore' },
      };
      const files = [
        file(1, '01 выпуск.mp4'),
        file(2, 'Трейлер.mp4'),
        file(3, '02 выпуск.mp4'),
        file(4, '03 выпуск.mp4'),
      ];
      const mappings = expandRule(rule, files);
      expect(mappings.find((m) => m.fileId === 2)).toBeUndefined();
      expect(mappings.find((m) => m.fileId === 1)?.episode).toBe(1);
      expect(mappings.find((m) => m.fileId === 3)?.episode).toBe(2);
      expect(mappings.find((m) => m.fileId === 4)?.episode).toBe(3);
    });

    it('an explicit override does not consume a position slot for sequential files', () => {
      const rule: Rule = {
        ...baseRule,
        exceptions: { '2': { season: 1, episode: 99 } }, // e.g. a special/OVA misfiled into this torrent
      };
      const files = [file(1, '01.mp4'), file(2, 'special.mp4'), file(3, '02.mp4')];
      const mappings = expandRule(rule, files);
      expect(mappings.find((m) => m.fileId === 2)).toEqual({
        fileId: 2,
        titleId: 'title-1',
        season: 1,
        episode: 99,
        ruleId: 'rule-1',
      });
      expect(mappings.find((m) => m.fileId === 1)?.episode).toBe(1);
      expect(mappings.find((m) => m.fileId === 3)?.episode).toBe(2);
    });
  });

  describe('non-video files', () => {
    it('are excluded entirely, never occupy a position slot', () => {
      const files = [
        file(1, '01 выпуск.mp4'),
        file(2, 'poster.jpg', false),
        file(3, '02 выпуск.mp4'),
      ];
      const mappings = expandRule(baseRule, files);
      expect(mappings.find((m) => m.fileId === 2)).toBeUndefined();
      expect(mappings).toHaveLength(2);
      expect(mappings.find((m) => m.fileId === 1)?.episode).toBe(1);
      expect(mappings.find((m) => m.fileId === 3)?.episode).toBe(2);
    });
  });
});

// Note: "a torrent where file count disagrees with X из Y" (§7) is not an
// expandRule case -- expandRule never sees "X из Y" at all. That's a
// proposeRule/confidence-scoring concern (spec §3.4, §5.3), covered by
// confidence.test.ts / proposeRule.test.ts once those exist (Milestone 5).
