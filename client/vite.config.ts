import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3000',
      '/events': 'http://localhost:3000'
    }
  }
});
