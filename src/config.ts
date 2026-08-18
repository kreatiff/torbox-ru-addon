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
  // --- Kinopoisk-backed `meta` resource (issue #28) ---
  // kinopoiskapiunofficial.tech token. Optional, same soft-fail shape as
  // TMDB_API_KEY: without it, the meta route serves without Kinopoisk
  // enrichment (description/genres/cast) rather than failing.
  KINOPOISK_API_KEY: z.string().optional(),
  // --- LLM-based auto-proposal (replaces the regex extractor cascade for
  // ingest-time auto-proposals; the cascade itself stays available as a
  // manual Labeller option). Optional: without a key, unruled torrents are
  // simply left for manual review, same as a failed title match today.
  OPENCODE_ZEN_API_KEY: z.string().optional(),
  OPENCODE_ZEN_MODEL: z.string().default('deepseek-v4-flash-free'),
  OPENCODE_ZEN_REQUEST_DELAY_MS: z.coerce.number().int().nonnegative().default(1000),
  // --- Admin UI authentication (Google OAuth) --------------------------------
  // Replaces HTTP Basic Auth. The app runs a standard OAuth 2.0 authorization
  // code flow with Google; only emails in ALLOWED_EMAILS may obtain a session.
  // SESSION_SECRET is used to encrypt the session cookie (must be >= 32 bytes).
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 bytes'),
  ALLOWED_EMAILS: z.string().min(1, 'ALLOWED_EMAILS is required'),
  // --- RuTracker feed scraper (docs/rutracker-scraper-plan.md) ---
  // Comma-separated Atom feed URLs. No default: an unset value forces the
  // consumer to fall back to the hardcoded constant inside fetchFeed.ts --
  // same pattern as NOT_WEB_READY_EXTENSIONS above.
  RUTRACKER_FEED_URLS: z.string().optional(),
  // Persist feed entries with no matching title (title_id = NULL), for
  // debugging the matcher. Off by default so feed_entries stays library-
  // scoped and bounded.
  RUTRACKER_STORE_UNMATCHED: z.coerce.boolean().default(false),
  // Base URL of a FlareSolverr instance (e.g. http://flaresolverr:8191),
  // used to fetch a matched entry's magnet link past RuTracker's Cloudflare
  // Turnstile challenge -- a plain server-side fetch gets a 403 (verified
  // directly against the live site; see docs/rutracker-scraper-plan.md).
  // No default: the "Download" action degrades to a clear error, not a
  // silent no-op, when this isn't configured.
  FLARESOLVERR_URL: z.url().optional(),
  // Discord incoming webhook URL. No default: notifications are entirely
  // opt-in.
  DISCORD_WEBHOOK_URL: z.url().optional(),
  // Minutes between automatic ingest runs (TorBox mylist refresh + RuTracker
  // feed poll + auto-proposals -- all one run, see runIngest). 0 disables
  // the scheduler entirely, leaving the existing manual triggers (the admin
  // UI button, `docker compose exec app node dist/ingest/runOnce.js`, or an
  // external cron hitting POST /api/ingest/run) as the only way to ingest.
  // Defaults on (15 min) since a scheduler is the whole point of this
  // setting -- an operator who wants manual-only sets this to 0 explicitly.
  INGEST_INTERVAL_MINUTES: z.coerce.number().int().nonnegative().default(15),
  // --- Inbound TorBox webhook (src/http/routes/webhooks) ---------------
  // Shared secret in the webhook URL path (/webhooks/torbox/:token), same
  // convention as ADDON_TOKEN. Optional: unset disables the route entirely
  // (every request 404s) rather than being reachable with an empty token.
  // Generate one with: openssl rand -hex 32
  TORBOX_WEBHOOK_TOKEN: z.string().optional(),
});

// Deployment tooling (e.g. docker-compose's `${VAR:-}` interpolation) commonly
// passes unset optional vars through as empty strings rather than omitting
// them. Treat "" the same as unset so e.g. `z.url().optional()` fields don't
// fail validation just because the operator didn't configure them.
function stripEmptyEnvValues(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== '') result[key] = value;
  }
  return result;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(stripEmptyEnvValues(env));
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
    kinopoiskApiKey: parsed.data.KINOPOISK_API_KEY,
    opencodeZenApiKey: parsed.data.OPENCODE_ZEN_API_KEY,
    opencodeZenModel: parsed.data.OPENCODE_ZEN_MODEL,
    opencodeZenRequestDelayMs: parsed.data.OPENCODE_ZEN_REQUEST_DELAY_MS,
    googleClientId: parsed.data.GOOGLE_CLIENT_ID,
    googleClientSecret: parsed.data.GOOGLE_CLIENT_SECRET,
    sessionSecret: parsed.data.SESSION_SECRET,
    allowedEmails: parsed.data.ALLOWED_EMAILS.split(',')
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
    rutrackerFeedUrls: parsed.data.RUTRACKER_FEED_URLS
      ? parsed.data.RUTRACKER_FEED_URLS.split(',')
          .map((url) => url.trim())
          .filter((url) => url.length > 0)
      : undefined,
    rutrackerStoreUnmatched: parsed.data.RUTRACKER_STORE_UNMATCHED,
    flaresolverrUrl: parsed.data.FLARESOLVERR_URL,
    discordWebhookUrl: parsed.data.DISCORD_WEBHOOK_URL,
    ingestIntervalMinutes: parsed.data.INGEST_INTERVAL_MINUTES,
    torboxWebhookToken: parsed.data.TORBOX_WEBHOOK_TOKEN,
  };
}

export type Config = ReturnType<typeof loadConfig>;

export const config: Config = loadConfig();
