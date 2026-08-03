// The only file in src/extract/ built so far -- the rest (vocabulary, token
// masking, the SxxExx/word-number/air-date cascade stages) is Milestone 5
// scope. This one stands alone: resolve's sort:'natural' needs it now
// (Milestone 2), and cascade stage 5 (positional fallback) will reuse it
// unchanged later.

/**
 * Compares strings the way a human would order filenames: digit runs compare
 * numerically, everything else compares lexically. Plain lexical sort turns
 * `1, 2, 10` into `1, 10, 2` and silently shifts every later episode by one --
 * this is the fix (spec §3.7).
 */
export function naturalCompare(a: string, b: string): number {
  const chunksA = a.match(/\d+|\D+/g) ?? [];
  const chunksB = b.match(/\d+|\D+/g) ?? [];
  const len = Math.min(chunksA.length, chunksB.length);

  for (let i = 0; i < len; i++) {
    const chunkA = chunksA[i];
    const chunkB = chunksB[i];
    if (chunkA === undefined || chunkB === undefined) {
      break;
    }
    const bothNumeric = /^\d+$/.test(chunkA) && /^\d+$/.test(chunkB);

    if (bothNumeric) {
      const diff = Number(chunkA) - Number(chunkB);
      if (diff !== 0) return diff;
    } else if (chunkA !== chunkB) {
      return chunkA < chunkB ? -1 : 1;
    }
  }

  return chunksA.length - chunksB.length;
}
