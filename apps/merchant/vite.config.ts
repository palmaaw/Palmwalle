import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // Do not silently move to another port: both the README and the deployed
    // links expect the POS app at :5174.
    strictPort: true,
    host: true,
    proxy: {
      '/api': 'http://localhost:8787'
    }
  }
});
