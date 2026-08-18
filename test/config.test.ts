import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    TORBOX_API_KEY: 'torbox-key',
    ADDON_TOKEN: 'addon-token',
    PUBLIC_BASE: 'https://example.com',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    SESSION_SECRET: 'a-very-long-secret-key-for-session-cookies',
    ALLOWED_EMAILS: 'admin@example.com',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('accepts a minimal valid environment', () => {
    expect(() => loadConfig(baseEnv())).not.toThrow();
  });

  it('treats empty-string optional vars as unset instead of failing validation', () => {
    // Mirrors docker-compose's `${DISCORD_WEBHOOK_URL:-}` interpolation, which
    // passes an empty string rather than omitting the variable entirely.
    const cfg = loadConfig(
      baseEnv({
        DISCORD_WEBHOOK_URL: '',
        FLARESOLVERR_URL: '',
        TMDB_API_KEY: '',
        RUTRACKER_FEED_URLS: '',
        TORBOX_WEBHOOK_TOKEN: '',
        OPENCODE_ZEN_API_KEY: '',
      }),
    );
    expect(cfg.discordWebhookUrl).toBeUndefined();
    expect(cfg.flaresolverrUrl).toBeUndefined();
    expect(cfg.tmdbApiKey).toBeUndefined();
    expect(cfg.rutrackerFeedUrls).toBeUndefined();
    expect(cfg.torboxWebhookToken).toBeUndefined();
    expect(cfg.opencodeZenApiKey).toBeUndefined();
  });

  it('still rejects an invalid (non-empty) URL for an optional field', () => {
    expect(() => loadConfig(baseEnv({ DISCORD_WEBHOOK_URL: 'not-a-url' }))).toThrow(
      /DISCORD_WEBHOOK_URL/,
    );
  });

  it('still requires required fields to be non-empty', () => {
    expect(() => loadConfig(baseEnv({ ADDON_TOKEN: '' }))).toThrow(/ADDON_TOKEN/);
  });
});
