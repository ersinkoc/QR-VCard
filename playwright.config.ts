import { defineConfig } from '@playwright/test';

/**
 * Two projects share this config:
 *
 * - `panel` — the /panel UI flows. Needs the full stack: a built dist/, the
 *   Directus container up (`npm run directus:up`), and global-setup provisions
 *   throwaway accounts. Run: npm run test:e2e
 * - `smoke` — pure API checks against a RUNNING deployment. With SMOKE_BASE_URL
 *   set it tests that deployment; without it, the webServer below starts
 *   server/serve.mjs on 4173. Run: npm run smoke
 *
 * The app server is started on a dedicated port (4173) so the tests never
 * collide with a dev server on 8787/8080. CI never reuses an existing server;
 * locally, `npm run smoke` attaches to one that is already listening.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    locale: 'en-GB',
  },
  projects: [
    { name: 'panel', testMatch: /panel\.spec\.ts/ },
    { name: 'smoke', testMatch: /smoke\.spec\.ts/ },
  ],
  webServer: {
    command: 'npx cross-env PORT=4173 node --env-file-if-exists=.env server/serve.mjs',
    port: 4173,
    timeout: 30_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
