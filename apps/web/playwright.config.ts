// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env['CI'];

// Escape hatch: run Chromium from a custom binary (e.g. a pre-provisioned
// browser) when the managed download is unavailable. Unset in CI → default.
const chromiumExecutable = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

export default defineConfig({
  testDir: './e2e',
  // The BFF-in-the-loop specs need the API e2e-server + proxied preview; the real-WebRTC
  // carrier spec needs the DEV server (ESM imports). Each has its own config; exclude both
  // from this frontend-only (preview) suite.
  testIgnore: /\.(bff|realwebrtc)\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  reporter: isCI ? 'html' : 'line',
  timeout: 30_000,
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
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    command: 'pnpm preview',
    port: 4173,
    reuseExistingServer: !isCI,
  },
});
