import { defineConfig } from '@playwright/test';

/**
 * ServeRest CompassUOL — https://compassuol.serverest.dev
 * REST API (Swagger at root). Shared public sandbox: tests self-seed unique
 * identities per worker and never assert on global counts.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    baseURL: process.env.SERVEREST_BASE_URL ?? 'https://compassuol.serverest.dev',
    extraHTTPHeaders: { 'Content-Type': 'application/json' },
    trace: 'on-first-retry',
  },
});
