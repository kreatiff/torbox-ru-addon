import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.url(),
  TORBOX_API_KEY: z.string().min(1, 'TORBOX_API_KEY is required'),
  TORBOX_REQUEST_DELAY_MS: z.coerce.number().int().nonnegative().default(250),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
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
  };
}

export type Config = ReturnType<typeof loadConfig>;

export const config: Config = loadConfig();
