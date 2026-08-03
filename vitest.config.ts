import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    // DB integration tests share one real Postgres and clean up via
    // truncate in beforeEach; cross-file parallelism would let one file's
    // truncate race another file's inserts against the same tables.
    fileParallelism: false,
  },
});
