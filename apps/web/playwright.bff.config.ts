// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BFF-in-the-loop E2E config (WS-P harness). Unlike playwright.config.ts (the
// frontend-only suite against the static preview), this boots BOTH the in-memory
// API e2e-server (port 3001) and the preview with its API proxy enabled
// (E2E_API_PROXY=1), so the browser drives the REAL authenticated WS-Q flows
// over one same-origin host. A random per-run SESSION_SECRET keeps the in-memory
// server's cookies valid without a committed secret.
import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env['CI'];
const chromiumExecutable = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
const sessionSecret = randomBytes(24).toString('hex');

export default defineConfig({
  testDir: './e2e',
  testMatch: /\.bff\.spec\.ts$/,
  // The in-memory API holds shared state across tests — run serially.
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? 'html' : 'line',
  timeout: 45_000,
  use: {
    baseURL: 'http://localhost:4173',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}),
      },
    },
    // Firefox/WebKit add coverage in CI; chromium suffices for local iteration.
    ...(isCI
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],
  webServer: [
    {
      command: 'pnpm --filter api e2e:server',
      port: 3001,
      reuseExistingServer: !isCI,
      timeout: 60_000,
      env: {
        NODE_ENV: 'development',
        LICIO_E2E: '1',
        PORT: '3001',
        SESSION_SECRET: sessionSecret,
        CORS_ORIGIN: 'http://localhost:4173',
        // Unused (in-memory stores) but required by the env validator.
        DATABASE_URL: 'postgres://e2e/e2e',
        REDIS_URL: 'redis://e2e:6379',
      },
    },
    {
      command: 'pnpm preview',
      port: 4173,
      reuseExistingServer: !isCI,
      timeout: 60_000,
      env: { E2E_API_PROXY: '1' },
    },
  ],
});
