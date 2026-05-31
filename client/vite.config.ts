import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': 'http://192.168.31.246:3000',
      '/events': 'http://192.168.31.246:3000'
    }
  }
});
