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
  // --- Admin UI authentication (Google OAuth) --------------------------------
  // Replaces HTTP Basic Auth. The app runs a standard OAuth 2.0 authorization
  // code flow with Google; only emails in ALLOWED_EMAILS may obtain a session.
  // SESSION_SECRET is used to encrypt the session cookie (must be >= 32 bytes).
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 bytes'),
  ALLOWED_EMAILS: z.string().min(1, 'ALLOWED_EMAILS is required'),
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
    googleClientId: parsed.data.GOOGLE_CLIENT_ID,
    googleClientSecret: parsed.data.GOOGLE_CLIENT_SECRET,
    sessionSecret: parsed.data.SESSION_SECRET,
    allowedEmails: parsed.data.ALLOWED_EMAILS.split(',')
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
  };
}

export type Config = ReturnType<typeof loadConfig>;

export const config: Config = loadConfig();
