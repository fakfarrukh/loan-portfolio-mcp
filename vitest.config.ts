import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests share no state (each builds its own in-memory DB), but keep output deterministic.
    env: { LOG_LEVEL: 'silent', OTEL_TRACES_EXPORTER: 'none' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/db/seed-cli.ts'],
    },
  },
});
