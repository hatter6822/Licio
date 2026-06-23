// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { stripDevCspMeta } from './src/dev/strip-csp-meta.js';

/**
 * Strip the production CSP `<meta>` from the served `index.html` in the DEV
 * SERVER ONLY (`vite dev`).  The pure transform lives in `stripDevCspMeta` (a
 * unit-tested dev helper); this plugin just applies it on `serve`.  `index.html`
 * carries the full production Content-Security-Policy as a `<meta http-equiv>`
 * because it is the SOLE CSP source in the WS-R.15.4a native-courier WebView
 * (which serves the built assets from `https://localhost` with no server
 * headers).  That policy is correct for the production build and the preview
 * server (whose header sends the same CSP), but in the Vite DEV server it breaks
 * the app: HMR injects CSS as inline `<style>` elements and uses inline/eval
 * script + a dev WebSocket, all of which `style-src 'self'` /
 * `require-trusted-types-for 'script'` / `connect-src 'self'` block — leaving
 * the app completely unstyled and flooding the console with CSP violations.
 * `apply: 'serve'` scopes this to dev only; `vite build` (and therefore the
 * courier `dist` + the preview) keeps the meta untouched, and the real CSP is
 * always enforced in production by the API's `security-headers.ts` header.
 */
function devStripCspMeta(): Plugin {
  return {
    name: 'licio:dev-strip-csp-meta',
    apply: 'serve',
    transformIndexHtml(html: string): string {
      return stripDevCspMeta(html);
    },
  };
}

function getHttpsConfig(): { key: Buffer; cert: Buffer } | undefined {
  if (process.env['DEV_HTTPS'] !== 'true') return undefined;
  const keyPath = resolve(__dirname, '../../localhost-key.pem');
  const certPath = resolve(__dirname, '../../localhost.pem');
  if (!existsSync(keyPath) || !existsSync(certPath)) return undefined;
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

// The BFF (Hono API) the dev server proxies to. HTTPS dev (DEV_HTTPS=true)
// serves the API over TLS on the same port (Section 10 of docs/DEVELOPMENT.md).
const API_PROXY_TARGET =
  process.env['DEV_HTTPS'] === 'true' ? 'https://localhost:3001' : 'http://localhost:3001';

export default defineConfig({
  base: '/',
  plugins: [
    // Dev-only: remove the production CSP <meta> so Vite HMR (inline styles +
    // scripts + dev WebSocket) is not blocked. No-op in `vite build`/preview.
    devStripCspMeta(),
    // File-based routing (WS-C.1.1a). Generates src/routeTree.gen.ts from the
    // route files and auto-code-splits each route's component. Must precede react().
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: 'src/routes',
      generatedRouteTree: 'src/routeTree.gen.ts',
      // First line carries the SPDX header so the generated file passes the CI
      // license-header check; the rest mirror the plugin defaults.
      routeTreeFileHeader: [
        '// SPDX-License-Identifier: AGPL-3.0-or-later',
        '/* eslint-disable */',
        '// @ts-nocheck',
        '// biome-ignore-all lint: generated file',
      ],
    }),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      // The brand icons live in public/assets and are already precached by the
      // Workbox `globPatterns` below (with a content revision). Disable the
      // separate manifest-icon injection, which would otherwise add the SAME
      // URLs a second time with `revision: null` — Workbox's addToCacheList then
      // throws `add-to-cache-list-conflicting-entries` at registration time and
      // the production service worker never installs (breaking offline precache,
      // updates, background sync, and push).
      includeManifestIcons: false,
      workbox: {
        // Precache the app shell + static assets (revision-hashed manifest).
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // The push handler is loaded via importScripts, not precached.
        globIgnores: ['**/sw-push.js'],
        // App-shell fallback for navigations enables client-side routing offline,
        // but API requests must never be served the shell.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/v1/],
        cleanupOutdatedCaches: true,
        // Prefix every cache (precache + runtime) for cache partitioning (§25.2).
        cacheId: 'licio',
        // Same-origin only — no remote code in the worker (WS-C.2.1d).
        importScripts: ['sw-push.js'],
        runtimeCaching: [
          {
            // API GETs: fresh when online, cached fallback offline. Mutations are
            // GET-only here, so POST/PUT/PATCH/DELETE are never cached.
            urlPattern: ({ url }: { url: URL }) =>
              url.pathname.startsWith('/v1') || url.pathname.startsWith('/api'),
            handler: 'NetworkFirst',
            method: 'GET',
            options: {
              cacheName: 'licio-api',
              expiration: { maxEntries: 200, maxAgeSeconds: 86_400 },
              // Do not cache opaque cross-origin responses (poisoning defense).
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ request }: { request: Request }) => request.destination === 'image',
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'licio-img',
              expiration: { maxEntries: 100, maxAgeSeconds: 604_800 },
            },
          },
          {
            urlPattern: ({ request }: { request: Request }) => request.destination === 'font',
            handler: 'CacheFirst',
            options: {
              cacheName: 'licio-font',
              expiration: { maxEntries: 10, maxAgeSeconds: 2_592_000 },
            },
          },
        ],
      },
      manifest: {
        name: 'Licio',
        short_name: 'Licio',
        description:
          'Social news and forum discussion built on participation-weighted attention, not popularity voting.',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        // Match the neumorphic fabric canvas (warm linen light surface; see tokens.ts).
        theme_color: '#F4ECDF',
        background_color: '#F4ECDF',
        scope: '/',
        start_url: '/?source=pwa',
        lang: 'en',
        dir: 'ltr',
        categories: ['news', 'social'],
        // The brand lockup (woven mark + wordmark) on a transparent field. Only
        // `purpose: 'any'` is declared: these are transparent lockups, so they
        // must NOT be marked `maskable` (a maskable icon is expected to paint the
        // full safe area edge-to-edge — a transparent one renders as a bare mark
        // inside the OS mask). A dedicated opaque, safe-zone-padded maskable icon
        // is tracked as a follow-up in docs/pwa-client/README.md.
        icons: [
          { src: '/assets/light_192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/assets/light_512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
        shortcuts: [
          { name: 'Submit', short_name: 'Submit', url: '/submit?source=pwa-shortcut' },
          { name: 'Front Page', short_name: 'Front Page', url: '/?source=pwa-shortcut' },
        ],
        // Citation capture (WS-G.3.7a): sharing a URL to Licio opens the
        // composer with the citation pre-populated. POST is handled by the
        // service worker (sw-push.js), which 303-redirects into /submit —
        // a static host never sees the POST.
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: { title: 'title', text: 'text', url: 'url' },
        },
      },
    }),
  ],
  resolve: {
    // dompurify reaches the graph through TWO workspace paths (the app's own
    // dependency and @licio/shared's UGC pipeline). Without dedupe, Rolldown
    // bundles it twice (~8.7KB gz) — one copy, one Trusted Types story.
    dedupe: ['dompurify', 'zod'],
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react')) {
            return 'react';
          }
          // WS-S.2.1 — keep the entire Private P2P plane in ONE lazily loaded chunk
          // whose file name contains `private-p2p`, so it is measured against its OWN
          // budget and excluded from the core total (PRIVATE_SPEC §9.8 — the private
          // plane is separately budgeted, never part of the public app's weight).  This
          // covers: the `@licio/private-p2p` core + its MLS/HPKE/curve deps, AND the
          // apps/web private-plane GLUE (`apps/web/src/private-p2p/*` — the room manager,
          // the live carrier, the sync session, the rendezvous client, the storage
          // adapter).  All of it is reached ONLY through the dynamic import in
          // `private-p2p/room-manager.ts`, so it never enters the initial bundle.
          if (
            id.includes('packages/private-p2p') ||
            id.includes('@licio/private-p2p') ||
            id.includes('apps/web/src/private-p2p') ||
            id.includes('node_modules/ts-mls') ||
            id.includes('node_modules/@noble') ||
            id.includes('node_modules/@hpke')
          ) {
            return 'private-p2p';
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    https: getHttpsConfig(),
    // Proxy the BFF surface SAME-ORIGIN to the API (:3001) so the zero-setup
    // `pnpm dev` path works without VITE_API_URL or CORS — exactly mirroring
    // production, where the PWA and API share one origin and the client calls
    // `/v1/*` relative. `/api/*` carries the CSRF-token + CSP-report endpoints;
    // `/v1/*` carries every data call, including the modules that fetch
    // same-origin and so bypass VITE_API_URL (telemetry, the link-safety
    // blocklist). Without the `/v1` entry those requests 404 against Vite.
    proxy: {
      '/api': { target: API_PROXY_TARGET, changeOrigin: true, secure: false },
      '/v1': { target: API_PROXY_TARGET, changeOrigin: true, secure: false },
    },
  },
  preview: {
    // BFF-in-the-loop E2E (WS-P harness): when E2E_API_PROXY=1, the preview
    // server proxies the API surface to the in-memory e2e-server so the browser
    // sees a SINGLE same-origin host (:4173) — a prerequisite for the
    // SameSite=Strict `__Host-` session cookie. Off by default (normal preview
    // is frontend-only, exactly as before).
    ...(process.env['E2E_API_PROXY'] === '1'
      ? {
          proxy: {
            '/v1': { target: 'http://localhost:3001', changeOrigin: true },
            '/api': { target: 'http://localhost:3001', changeOrigin: true },
            '/health': { target: 'http://localhost:3001', changeOrigin: true },
          },
        }
      : {}),
    headers: {
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "worker-src 'self'",
        "manifest-src 'self'",
        "frame-ancestors 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        'trusted-types default dompurify licio-ugc',
        "require-trusted-types-for 'script'",
        'report-uri /api/security/csp-report',
        'report-to csp-endpoint',
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy':
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=(), serial=(), midi=()',
    },
  },
});
