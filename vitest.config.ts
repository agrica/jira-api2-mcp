import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // scripts/*.ts are thin command-line wrappers (argument parsing, file and git I/O, exit codes)
      // over scripts/lib/**, which holds their logic and is measured. They are exercised by CI
      // (catalog-and-package job) rather than by unit tests, so they are left out of the metric.
      include: ['src/**/*.ts', 'scripts/lib/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        // Test helpers, not product code.
        'src/test-support/**',
        // Process wiring only: main.ts holds the logic and is measured. src/index.test.ts spawns
        // this file as a child process, which v8 coverage does not instrument.
        'src/index.ts',
      ],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
});
