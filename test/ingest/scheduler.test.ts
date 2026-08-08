import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { config } from '../../src/config.js';
import { runIngest } from '../../src/ingest/pipeline.js';
import { startIngestScheduler } from '../../src/ingest/scheduler.js';

vi.mock('../../src/ingest/pipeline.js', () => ({
  runIngest: vi.fn(),
}));

describe('startIngestScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(runIngest).mockReset().mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does nothing when INGEST_INTERVAL_MINUTES is 0', async () => {
    vi.spyOn(config, 'ingestIntervalMinutes', 'get').mockReturnValue(0);
    const { stop } = startIngestScheduler();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runIngest).not.toHaveBeenCalled();
    stop();
  });

  it('runs once immediately, then again every interval', async () => {
    vi.spyOn(config, 'ingestIntervalMinutes', 'get').mockReturnValue(15);
    const { stop } = startIngestScheduler();
    expect(runIngest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(runIngest).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(runIngest).toHaveBeenCalledTimes(3);

    stop();
  });

  it('skips a tick if the previous run is still in progress, instead of overlapping', async () => {
    vi.spyOn(config, 'ingestIntervalMinutes', 'get').mockReturnValue(15);
    let resolveFirst!: () => void;
    vi.mocked(runIngest).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = () => resolve({} as never);
      }),
    );

    const { stop } = startIngestScheduler();
    expect(runIngest).toHaveBeenCalledTimes(1);

    // The first run is still pending when the next tick fires.
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(runIngest).toHaveBeenCalledTimes(1);

    // Once it resolves, the next tick runs normally again.
    resolveFirst();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(runIngest).toHaveBeenCalledTimes(2);

    stop();
  });

  it('stop() prevents any further scheduled runs', async () => {
    vi.spyOn(config, 'ingestIntervalMinutes', 'get').mockReturnValue(15);
    const { stop } = startIngestScheduler();
    expect(runIngest).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runIngest).toHaveBeenCalledTimes(1);
  });
});
