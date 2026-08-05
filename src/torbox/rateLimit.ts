import { config } from '../config.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `items` through `fn` serially with a fixed delay between calls rather
 * than guessing a concurrency number — conservative by construction, tune
 * `delayMs` from real 429s once they're observed. Defaults to
 * TORBOX_REQUEST_DELAY_MS (this function's original and still most common
 * caller); pass an explicit `delayMs` for other rate-limited APIs (e.g. the
 * LLM extraction client).
 */
export async function throttledMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  delayMs: number = config.torboxRequestDelayMs,
): Promise<R[]> {
  const results: R[] = [];
  for (const [index, item] of items.entries()) {
    if (index > 0) {
      await sleep(delayMs);
    }
    results.push(await fn(item));
  }
  return results;
}
