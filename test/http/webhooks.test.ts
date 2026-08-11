import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { build } from '../../src/http/server.js';
import { config } from '../../src/config.js';
import { runIngestDeduped } from '../../src/ingest/pipeline.js';
import type * as PipelineModule from '../../src/ingest/pipeline.js';

vi.mock('../../src/ingest/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PipelineModule>();
  return { ...actual, runIngestDeduped: vi.fn() };
});

describe('POST /webhooks/torbox/:token', () => {
  beforeEach(() => {
    vi.mocked(runIngestDeduped).mockReset().mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('404s when TORBOX_WEBHOOK_TOKEN is unset, regardless of the token supplied', async () => {
    vi.spyOn(config, 'torboxWebhookToken', 'get').mockReturnValue(undefined);
    const app = build();

    const response = await app.inject({ method: 'POST', url: '/webhooks/torbox/anything' });

    expect(response.statusCode).toBe(404);
    expect(runIngestDeduped).not.toHaveBeenCalled();
    await app.close();
  });

  it('404s on a wrong token', async () => {
    vi.spyOn(config, 'torboxWebhookToken', 'get').mockReturnValue('correct-token');
    const app = build();

    const response = await app.inject({ method: 'POST', url: '/webhooks/torbox/wrong-token' });

    expect(response.statusCode).toBe(404);
    expect(runIngestDeduped).not.toHaveBeenCalled();
    await app.close();
  });

  it('accepts a correct token, acks 200, and triggers a deduped ingest run', async () => {
    vi.spyOn(config, 'torboxWebhookToken', 'get').mockReturnValue('correct-token');
    const app = build();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/torbox/correct-token',
      payload: {
        event: 'torbox.notification',
        timestamp: '2026-01-01T00:00:00Z',
        data: { title: 'Download Finished', message: 'Some.Show.S01E01.mkv' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(runIngestDeduped).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('does not reject an unparseable / non-JSON body -- the payload shape is never load-bearing', async () => {
    vi.spyOn(config, 'torboxWebhookToken', 'get').mockReturnValue('correct-token');
    const app = build();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/torbox/correct-token',
      headers: { 'content-type': 'text/plain' },
      payload: 'not json at all',
    });

    expect(response.statusCode).toBe(200);
    expect(runIngestDeduped).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('responds before the background ingest run resolves', async () => {
    vi.spyOn(config, 'torboxWebhookToken', 'get').mockReturnValue('correct-token');
    let resolveIngest: () => void = () => undefined;
    vi.mocked(runIngestDeduped).mockReturnValue(
      new Promise((resolve) => {
        resolveIngest = () => resolve({} as never);
      }),
    );
    const app = build();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/torbox/correct-token',
    });

    // The route already responded even though the mocked ingest run's
    // promise is still pending -- proves this is genuinely fire-and-forget,
    // not awaited before the reply is sent.
    expect(response.statusCode).toBe(200);
    resolveIngest();
    await app.close();
  });
});
