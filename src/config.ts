import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.url(),
  TORBOX_API_KEY: z.string().min(1, 'TORBOX_API_KEY is required'),
  TORBOX_REQUEST_DELAY_MS: z.coerce.number().int().nonnegative().default(250),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  // --- Milestone 3 (src/http, the addon) ---
  ADDON_TOKEN: z.string().min(1, 'ADDON_TOKEN is required'),
  PUBLIC_BASE: z.url(),
  PORT: z.coerce.number().int().positive().default(3000),
  // Comma-separated, case-insensitive file extensions (no leading dot) that
  // get `notWebReady: true` in Stream objects. Spec (§5.5) asks for "a
  // per-file computed flag with an env override" -- this makes the
  // computation itself configurable rather than a blunt global switch.
  NOT_WEB_READY_EXTENSIONS: z.string().default('ts'),
  // --- Milestone 4 (src/ui, admin UI & metadata) ---
  TMDB_API_KEY: z.string().optional(),
  // --- LLM-based auto-proposal (replaces the regex extractor cascade for
  // ingest-time auto-proposals; the cascade itself stays available as a
  // manual Labeller option). Optional: without a key, unruled torrents are
  // simply left for manual review, same as a failed title match today.
  OPENCODE_ZEN_API_KEY: z.string().optional(),
  OPENCODE_ZEN_MODEL: z.string().default('deepseek-v4-flash-free'),
  OPENCODE_ZEN_REQUEST_DELAY_MS: z.coerce.number().int().nonnegative().default(1000),
  // No default: this gates the entire admin surface (rule creation, ingest
  // trigger, library/health data) behind HTTP Basic Auth, reachable from the
  // same public Cloudflare Tunnel as the addon. A guessable default here
  // defeats that gate entirely -- same reasoning as ADDON_TOKEN above.
  ADMIN_USER: z.string().min(1, 'ADMIN_USER is required'),
  ADMIN_PASS: z.string().min(1, 'ADMIN_PASS is required'),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    torboxApiKey: parsed.data.TORBOX_API_KEY,
    torboxRequestDelayMs: parsed.data.TORBOX_REQUEST_DELAY_MS,
    logLevel: parsed.data.LOG_LEVEL,
    nodeEnv: parsed.data.NODE_ENV,
    addonToken: parsed.data.ADDON_TOKEN,
    publicBase: parsed.data.PUBLIC_BASE,
    port: parsed.data.PORT,
    notWebReadyExtensions: parsed.data.NOT_WEB_READY_EXTENSIONS.split(',')
      .map((ext) => ext.trim().toLowerCase())
      .filter((ext) => ext.length > 0),
    tmdbApiKey: parsed.data.TMDB_API_KEY,
    adminUser: parsed.data.ADMIN_USER,
    adminPass: parsed.data.ADMIN_PASS,
    opencodeZenApiKey: parsed.data.OPENCODE_ZEN_API_KEY,
    opencodeZenModel: parsed.data.OPENCODE_ZEN_MODEL,
    opencodeZenRequestDelayMs: parsed.data.OPENCODE_ZEN_REQUEST_DELAY_MS,
  };
}

export type Config = ReturnType<typeof loadConfig>;

export const config: Config = loadConfig();
