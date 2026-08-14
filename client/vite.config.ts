import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const DEV_PROXY_TARGET = 'http://127.0.0.1:3000';
const DEV_PROXY_HOST = new URL(DEV_PROXY_TARGET).host;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Vite 不读 tsconfig.base.json 的 paths；@dnd/contracts 直接解析到源码，
      // dev/client build/tests 都不依赖预先构建的 packages/contracts/dist。
      '@dnd/contracts': fileURLToPath(
        new URL('../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5180,
    // 普通 npm run dev 遇到残留 Vite 进程时自动尝试下一个端口；
    // Phase 4 runner 会显式覆盖为 strictPort，保持测试端口隔离。
    strictPort: false,
    proxy: {
      // 本地 server 的安全策略要求可信反向代理明确声明 HTTPS。
      // 浏览器仍访问 Vite 的 HTTP 地址；只允许 loopback proxy 注入这些转发头。
      '/api': {
        target: DEV_PROXY_TARGET,
        changeOrigin: true,
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': DEV_PROXY_HOST,
        },
      },
    },
  }
});
