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
  };
}

export type Config = ReturnType<typeof loadConfig>;

export const config: Config = loadConfig();
