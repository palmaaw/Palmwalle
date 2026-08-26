import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Do not silently move to another port: both the README and the deployed
    // links expect the customer app at :5173.
    strictPort: true,
    host: true,
    proxy: {
      // The API runs separately on :8787; in dev the PWA talks to it same-origin.
      '/api': 'http://localhost:8787'
    }
  }
});
