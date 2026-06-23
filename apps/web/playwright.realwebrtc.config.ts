// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WP-9 / WS-S.4.3 — the REAL-browser carrier E2E config.  Unlike the frontend-only
// (preview) and BFF configs, this runs against the VITE DEV server, which serves the
// app's source as ES modules — so a `page.evaluate` can dynamically `import()` the
// actual `connect-peer.ts` carrier + `@licio/private-p2p`, exercising the REAL carrier
// (discovery/sealed-signaling/§15.5-handshake/op-exchange) over a real Chromium
// `RTCPeerConnection`, not a hand-rolled peer pair.  Chromium only (headless WebRTC is
// reliable there); the rendezvous is bridged in-page (no server endpoint needed).

import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env['CI'];
const chromiumExecutable = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

export default defineConfig({
  testDir: './e2e',
  testMatch: /\.realwebrtc\.spec\.ts$/,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI ? 'html' : 'line',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
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
  ],
  webServer: {
    // The Vite dev server serves /src + workspace packages as ES modules.
    command: 'pnpm dev',
    port: 5173,
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
