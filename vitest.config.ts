import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/api/src/**/*.test.ts'],
    environment: 'node',
    // Biometric separation sweeps are pure CPU but not instant; keep a sane ceiling.
    testTimeout: 30_000
  }
});
