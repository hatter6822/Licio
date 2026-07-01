// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WP-9 / WS-S.4.3 — the REAL-browser carrier E2E config.  Unlike the frontend-only
// (preview) and BFF configs, this runs against the VITE DEV server, which serves the
// app's source as ES modules — so a `page.evaluate` can dynamically `import()` the
// actual `connect-peer.ts` carrier + `@licio/private-p2p`, exercising the REAL carrier
// (discovery/sealed-signaling/§15.5-handshake/op-exchange) over a real Chromium
// `RTCPeerConnection`, not a hand-rolled peer pair.  Chromium only (headless WebRTC is
// reliable there); the rendezvous is bridged in-page (no server endpoint needed).

import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env['CI'];
const chromiumExecutable = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
const sessionSecret = randomBytes(24).toString('hex');

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
        launchOptions: {
          // Disable Chromium's mDNS host-candidate obfuscation so two BROWSER CONTEXTS (the
          // two-browser private-room E2E) connect via real loopback host candidates WITHOUT a
          // STUN server / internet — the .local names would otherwise not resolve across contexts.
          // Harmless for the single-page carrier specs (they gain real host IPs instead of .local).
          args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
          ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
        },
      },
    },
  ],
  webServer: [
    // The in-memory API (mounts `createApp` → the real `/v1/private-rendezvous/*` endpoints) so
    // the two-browser private-room spec signals over the LIVE server-blind rendezvous (the Vite dev
    // server below proxies `/v1` + `/api` → :3001).  The single-page carrier specs bridge rendezvous
    // in-page and simply ignore it.
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
        CORS_ORIGIN: 'http://localhost:5173',
        // Unused (in-memory stores) but required by the env validator.
        DATABASE_URL: 'postgres://e2e/e2e',
        REDIS_URL: 'redis://e2e:6379',
      },
    },
    // The Vite dev server serves /src + workspace packages as ES modules (so `page.evaluate` can
    // dynamically import the REAL carrier + `@licio/private-p2p`), and proxies `/v1` → :3001.
    {
      command: 'pnpm dev',
      port: 5173,
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
  ],
});
