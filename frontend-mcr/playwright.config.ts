import { defineConfig } from '@playwright/test';

const BASE_URL = 'https://ldldfcndl8jbd1z-jitdemodatabase.adb.uk-london-1.oraclecloudapps.com/ords/jit_schema/mcr-app/';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 1,
  reporter: 'html',
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
