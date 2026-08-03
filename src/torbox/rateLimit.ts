import { config } from '../config.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TorBox doesn't publish a rate limit. Runs `items` through `fn` serially
 * with a fixed delay between calls rather than guessing a concurrency
 * number — conservative by construction, tune TORBOX_REQUEST_DELAY_MS from
 * real 429s once they're observed.
 */
export async function throttledMap<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (const [index, item] of items.entries()) {
    if (index > 0) {
      await sleep(config.torboxRequestDelayMs);
    }
    results.push(await fn(item));
  }
  return results;
}
