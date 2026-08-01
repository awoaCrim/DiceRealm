import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'server/src/tests/**/*.test.ts', 'client/src/**/*.test.tsx'],
    globals: true
  }
});
