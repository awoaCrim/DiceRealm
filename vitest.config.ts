import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'server/src/tests/**/*.test.ts', 'server/src/platform/**/*.test.ts', 'server/src/modules/**/*.test.ts', 'client/src/**/*.test.tsx'],
    globals: true
  }
});
