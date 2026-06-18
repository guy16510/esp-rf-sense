import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'dashboard.spec.mjs',
  timeout: 30_000,
  retries: 1,
  workers: 1,
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: 'apps/dashboard/e2e/artifacts/report',
        open: 'never',
      },
    ],
  ],
  outputDir: 'apps/dashboard/e2e/artifacts/results',
  use: {
    viewport: { width: 1720, height: 1100 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
