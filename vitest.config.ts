import { fileURLToPath } from 'node:url';
import { defineConfig, defaultExclude } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // contracts 的 package exports 指向编译产物 dist；测试应始终使用源码，
      // 避免依赖预先构建 contracts。
      '@dnd/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/**/*.test.ts',
      'server/src/tests/**/*.test.ts',
      'server/src/platform/**/*.test.ts',
      'server/src/modules/**/*.test.ts',
      'client/src/**/*.test.ts',
      'client/src/**/*.test.tsx',
    ],
    // browser 场景仅由独立 tsx runner 执行，排除出普通 npm test。
    exclude: [...defaultExclude, 'client/src/tests/phase4-browser-flow.test.ts'],
    globals: true,
  },
});
