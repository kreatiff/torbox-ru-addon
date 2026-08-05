import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';

const OPENCODE_ZEN_URL = 'https://opencode.ai/zen/v1/chat/completions';
// deepseek-v4-flash-free is a reasoning model that emits hidden
// reasoning_content before its answer -- observed ~35s for even a trivial
// one-line reply on Zen's free tier, so a tight timeout here fires on
// perfectly healthy responses, not just genuinely stuck requests.
const REQUEST_TIMEOUT_MS = 90_000;

const chatCompletionSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string(),
      }),
    }),
  ),
});

const extractionFileSchema = z.object({
  fileId: z.number().int(),
  episode: z.number().int().nullable(),
});

const extractionSchema = z.object({
  title: z.string(),
  titleEn: z.string().nullable(),
  year: z.number().int().nullable(),
  season: z.number().int(),
  files: z.array(extractionFileSchema),
  confident: z.boolean(),
  reasoning: z.string(),
});

export interface LlmExtractionFile {
  fileId: number;
  episode: number | null;
}

export interface LlmExtraction {
  title: string;
  titleEn: string | null;
  year: number | null;
  season: number;
  files: LlmExtractionFile[];
  confident: boolean;
  reasoning: string;
}

export interface LlmExtractionFileInput {
  fileId: number;
  path: string;
  size?: number;
}

const SYSTEM_PROMPT = `You extract structured episode metadata from Russian-tracker TV torrent names and file lists.

Return ONLY a single JSON object, no markdown code fences, no commentary, matching exactly this shape:
{
  "title": string,        // cleaned canonical show title (Russian name if present, otherwise original)
  "titleEn": string|null, // English/transliterated title if you can infer one, else null
  "year": number|null,    // first-air year if present, else null
  "season": number,       // season number (default 1 if the torrent doesn't specify one)
  "files": [{ "fileId": number, "episode": number|null }], // one entry per video file given, in the order given
  "confident": boolean,   // true only if you are confident about BOTH the title AND every episode number
  "reasoning": string     // one or two sentences explaining your extraction, for a human reviewer
}

"episode" should be null for a file that is not a real episode (trailer, sample, extras, behind-the-scenes),
not a guessed number.

Known pitfalls to watch for, from real failures of a previous regex-based extractor:
- Torrent names often carry a leading site tag before the real title, e.g. "rutor.info_Show Name ...".
  Strip these; they are not part of the title.
- "X из Y" ("X of Y") is a completeness count, not an episode number, and can appear in several word
  orders, e.g. "1-12 выпуск из 12" (range, then the word "выпуск"/episode, THEN "из Y") as well as the
  simpler "8 из 13". Do not let this phrase leak into the title.
- File names are frequently just "01. <full repeated title>.ext", "02. <full repeated title>.ext", etc,
  with no "S01E01"-style marker at all. The leading bare number IS the episode number within the season,
  in file order.
- Cyrillic and Latin lookalike characters (е/e, о/o, р/p, etc.) are sometimes mixed within one name;
  treat them as the same letter when reading it.`;

function stripCodeFences(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}

async function chatComplete(messages: { role: string; content: string }[]): Promise<string> {
  const response = await fetch(OPENCODE_ZEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.opencodeZenApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.opencodeZenModel,
      temperature: 0,
      messages,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error({ status: response.status, body: text }, 'OpenCode Zen request failed');
    throw new Error(`OpenCode Zen returned HTTP ${response.status}: ${text}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    logger.error({ status: response.status }, 'OpenCode Zen response was not valid JSON');
    throw new Error(`OpenCode Zen returned a non-JSON response (HTTP ${response.status})`);
  }

  const parsed = chatCompletionSchema.parse(body);
  const content = parsed.choices[0]?.message.content;
  if (content === undefined) {
    throw new Error('OpenCode Zen response had no choices');
  }
  return content;
}

function buildUserPrompt(torrentName: string, files: LlmExtractionFileInput[]): string {
  const fileLines = files
    .map((f) => `- fileId ${f.fileId}: ${f.path}${f.size !== undefined ? ` (${f.size} bytes)` : ''}`)
    .join('\n');
  return `Torrent name: ${torrentName}\n\nVideo files:\n${fileLines}`;
}

/**
 * Extracts {title, season, per-file episode} from a torrent name + file list via
 * OpenCode Zen. Returns null (with a warn log) when no API key is configured, matching
 * TMDB's searchTitles graceful-degradation pattern -- the caller treats that the same as
 * a failed title match (queued for manual review).
 */
export async function extractEpisodes(
  torrentName: string,
  files: LlmExtractionFileInput[],
): Promise<LlmExtraction | null> {
  if (!config.opencodeZenApiKey) {
    logger.warn('OPENCODE_ZEN_API_KEY not configured. Skipping LLM extraction.');
    return null;
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(torrentName, files) },
  ];

  let content = await chatComplete(messages);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = JSON.parse(stripCodeFences(content));
      return extractionSchema.parse(json);
    } catch (err) {
      if (attempt === 1) {
        logger.error({ err, content }, 'OpenCode Zen did not return valid extraction JSON after retry');
        throw new Error('OpenCode Zen did not return valid extraction JSON', { cause: err });
      }
      logger.warn({ content }, 'OpenCode Zen response was not valid JSON, retrying once');
      messages.push(
        { role: 'assistant', content },
        { role: 'user', content: 'That was not a valid JSON object matching the required shape. Reply with ONLY the JSON object.' },
      );
      content = await chatComplete(messages);
    }
  }
  // Unreachable: the loop above always returns or throws.
  throw new Error('OpenCode Zen extraction failed');
}
