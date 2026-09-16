import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright end-to-end configuration for the Helpdesk app.
 *
 * These tests drive the REAL app in a browser against the running dev servers
 * (Angular on :4200 proxying /api to the Express backend on :3000, seeded via
 * `npm --prefix backend run seed`). They exercise the requester ↔ support
 * lifecycle across screens and assert that the UI presents human-readable
 * content (names/titles, never internal ids) and that actions produce the
 * expected results.
 *
 * Run: `npm run e2e` (servers must be up: `npm run dev`, DB seeded).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // shared seeded DB: keep lifecycle specs deterministic
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:4200',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
