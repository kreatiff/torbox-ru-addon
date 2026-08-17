import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { config } from '../../src/config.js';
import { runIngestDeduped } from '../../src/ingest/pipeline.js';
import { startIngestScheduler } from '../../src/ingest/scheduler.js';

vi.mock('../../src/ingest/pipeline.js', () => ({
  runIngestDeduped: vi.fn(),
}));

describe('startIngestScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(runIngestDeduped).mockReset().mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does nothing when INGEST_INTERVAL_MINUTES is 0', async () => {
    vi.spyOn(config, 'ingestIntervalMinutes', 'get').mockReturnValue(0);
    const { stop } = startIngestScheduler();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runIngestDeduped).not.toHaveBeenCalled();
    stop();
  });

  it('runs once immediately, then again every interval', async () => {
    vi.spyOn(config, 'ingestIntervalMinutes', 'get').mockReturnValue(15);
    const { stop } = startIngestScheduler();
    expect(runIngestDeduped).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(runIngestDeduped).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(runIngestDeduped).toHaveBeenCalledTimes(3);

    stop();
  });

  it('ticks call runIngestDeduped every interval even if the previous run is still in flight', async () => {
    // The scheduler no longer guards re-entrancy itself -- runIngestDeduped()
    // (shared with the webhook and the admin "run now" trigger) is
    // responsible for coalescing overlapping runs, so every tick calls it
    // unconditionally and lets it decide whether to start a new run or join
    // the one already in progress.
    vi.spyOn(config, 'ingestIntervalMinutes', 'get').mockReturnValue(15);
    vi.mocked(runIngestDeduped).mockReturnValue(
      new Promise(() => {
        // Never resolves -- simulates a run still in flight.
      }),
    );

    const { stop } = startIngestScheduler();
    expect(runIngestDeduped).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(runIngestDeduped).toHaveBeenCalledTimes(2);

    stop();
  });

  it('stop() prevents any further scheduled runs', async () => {
    vi.spyOn(config, 'ingestIntervalMinutes', 'get').mockReturnValue(15);
    const { stop } = startIngestScheduler();
    expect(runIngestDeduped).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runIngestDeduped).toHaveBeenCalledTimes(1);
  });
});
