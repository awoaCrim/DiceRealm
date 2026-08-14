import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('client Vite development config', () => {
  it('keeps the documented port as the default while allowing fallback when occupied', () => {
    expect(config.server).toMatchObject({
      port: 5180,
      strictPort: false,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3000',
          changeOrigin: true,
          headers: {
            'x-forwarded-proto': 'https',
            'x-forwarded-host': '127.0.0.1:3000',
          },
        },
      },
    });
  });
});
