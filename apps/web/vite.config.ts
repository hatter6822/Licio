// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

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
        // Match the neumorphic fabric canvas (light surface; see tokens.ts).
        theme_color: '#EAEDF3',
        background_color: '#EAEDF3',
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
