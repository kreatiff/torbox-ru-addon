// Exported: this is the floor GET /api/queue, rebuildAllMappings(), and
// proposeRule() use to recognise a rule as still pending human review
// (source: 'auto' and confidence below this). Previously also the boundary
// between the regex cascade's 'medium' and 'queue' tiers; that scoring
// engine is gone (replaced by LLM-based auto-proposal, see
// src/llm/opencodeZen.ts and src/resolve/proposeRule.ts) but the floor
// itself is still load-bearing for the three call sites above.
export const MEDIUM_SCORE_THRESHOLD = 0.45;

export interface ProviderSeason {
  season: number;
  episode_count: number;
  episodes: { episode: number; air_date: string | null }[];
}

export interface TitleMatch {
  titleId: string;
  nameRu: string;
  nameEn: string | null;
  seasons: ProviderSeason[];
}
