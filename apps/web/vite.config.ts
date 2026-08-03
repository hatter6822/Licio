// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
// RELATIVE, not `@licio/shared`: Vite's config loader EXTERNALISES a bare
// workspace specifier, and Node then cannot resolve this package's
// `.js`-suffixed TypeScript source at config-eval time.  A relative import is
// bundled into the config, so the policy really is single-sourced.
import {
  contentSecurityPolicyHeader,
  contentSecurityPolicyMeta,
} from '../../packages/shared/src/security/csp.js';
import { injectCspMeta } from './src/dev/inject-csp-meta.js';

/**
 * INJECT the Content-Security-Policy `<meta http-equiv>` into the BUILT
 * `index.html`, from the single source in `@licio/shared` (`security/csp.ts`).
 *
 * `index.html` deliberately carries no policy of its own.  It used to, and that
 * copy had to be kept in step by hand with the API response header and the
 * preview header below — three spellings of one policy, where tightening the
 * header alone left the WS-R.15.4a native courier WebView (which serves the
 * built assets from `https://localhost`, so the `<meta>` is its ONLY policy) on
 * the older, weaker rules.
 *
 * `apply: 'build'` also disposes of the previous dev-only STRIP plugin: the Vite
 * dev server simply never receives a tag, which it could not tolerate anyway
 * (HMR uses inline `<style>`, inline/eval script and a dev WebSocket, all
 * blocked by `style-src 'self'` / `require-trusted-types-for 'script'` /
 * `connect-src 'self'`).  `vite build` — and therefore the courier `dist` and
 * the preview server — gets the real policy.
 */
function buildInjectCspMeta(): Plugin {
  return {
    name: 'licio:inject-csp-meta',
    apply: 'build',
    transformIndexHtml(html: string): string {
      return injectCspMeta(html, contentSecurityPolicyMeta());
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
    // Build-only: inject the production CSP <meta> from the shared SSOT (the
    // courier WebView's only policy). No-op in `vite dev`, whose HMR the policy
    // would block.
    buildInjectCspMeta(),
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
            //
            // NEVER-CACHED surfaces (codex on PR #146) — a NetworkFirst cache
            // replays its last 200 whenever the network path fails, BYPASSING
            // the server's per-request authorization for up to 24h:
            //   • /v1/auth/*: a cached /status could answer a later login as an
            //     OLDER session, and the sign-out purge races any in-flight
            //     auth GET whose cache write lands after the delete.  Offline
            //     boot does not need it — the auth store's zod-validated
            //     localStorage context covers relaunch, and a network error
            //     (unlike a 401) never downgrades the session.
            //   • operator consoles — any '/admin' segment (compliance cases/
            //     fraud queue/policies, counsel SAR + lawful access, ingestion/
            //     invariants/ranking/events/ai/knomosis/forum admin) and the
            //     WS-J console mount /v1/moderation: these reads sit behind
            //     role + per-session-MFA gates that a cached replay would skip
            //     for a role-revoked operator or a later shared-browser
            //     session.  Operator surfaces are online-only by design.
            //   • /v1/knomosis/actions/*: the WS-L action-status read carries
            //     an operator (platform-admin) arm without an '/admin' path
            //     segment, and a FINANCIAL pipeline status must never replay
            //     stale from a cache anyway — a settled/failed action shown
            //     as pending misleads exactly when the network is flaky.
            //   • /v1/private-rooms/*: the §21.2 bootstrap read is a CAPABILITY
            //     check (an unlisted record needs its blind token) and its
            //     answer changes on delist/DELETE.  A NetworkFirst replay would
            //     serve an unlisted record — or a formerly-listed record's
            //     public name — offline for up to 24h after it was removed,
            //     without ever consulting the current token or directory state.
            //   • /api/csrf-token: the double-submit token is SINGLE-USE (each
            //     mutation fetches a fresh one). A NetworkFirst fallback would
            //     replay a consumed token, silently 403-ing the next mutation;
            //     a security token has no business in a durable cache anyway.
            urlPattern: ({ url }: { url: URL }) =>
              (url.pathname.startsWith('/v1') || url.pathname.startsWith('/api')) &&
              !url.pathname.startsWith('/v1/auth/') &&
              !url.pathname.startsWith('/v1/moderation') &&
              !url.pathname.startsWith('/v1/knomosis/actions') &&
              !url.pathname.startsWith('/v1/private-rooms') &&
              !url.pathname.startsWith('/api/csrf-token') &&
              !url.pathname.includes('/admin'),
            handler: 'NetworkFirst',
            method: 'GET',
            options: {
              cacheName: 'licio-api',
              expiration: { maxEntries: 200, maxAgeSeconds: 86_400 },
              // Cache ONLY same-origin 200s. Status 0 IS the opaque cross-origin
              // response — including it would cache poisoned/opaque bodies, the
              // exact opposite of the poisoning defense this line is meant to be.
              cacheableResponse: { statuses: [200] },
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
        // Rolldown's NATIVE grouping, not the `manualChunks` shim.
        //
        // A group captures its members AND, by default
        // (`includeDependenciesRecursively`), everything they depend on.  Both
        // lazy planes depend on `@licio/shared` — hence on `zod` and
        // `dompurify` — and the LCAP transport plane depends on the
        // `@licio/lcap` core, so those shared modules were pulled INTO the
        // plane chunks.  Every eager chunk that needed them then carried a
        // STATIC import of a plane chunk, Vite emitted a
        // `<link rel="modulepreload">` for each, and 262 KiB gz of
        // MLS/HPKE/curve and QR-decoder code was downloaded on every first
        // paint.
        //
        // All three guards meant to prevent that reported green:
        // `check:private-p2p-split` / `check:lcap-p2p-split` police the
        // `@licio/*` package SPECIFIERS in app source — which genuinely are
        // dynamic-only, and still are (the leak was in the chunker, not the
        // imports) — and `check-bundle-size.ts` skipped these chunks by FILE
        // NAME before doing its initial-payload accounting.  That gate now
        // fails if a plane chunk is preloaded, which is the property these
        // groups exist to keep true.
        //
        // `includeDependenciesRecursively: false` is therefore the load-bearing
        // setting: each plane group captures ONLY its own modules, and the
        // shared cores stay in the ordinary graph, where the eager app needs
        // them anyway.
        codeSplitting: {
          groups: [
            // WS-S.2.1 — the Private P2P plane: the `@licio/private-p2p` core
            // and the MLS/HPKE/curve vendors nothing else uses.  Reached only
            // through the dynamic import in `private-p2p/room-manager.ts`.  The
            // apps/web GLUE (`apps/web/src/private-p2p/*`) is deliberately NOT
            // captured: eleven components and the private route page import it
            // directly, so capturing it made the plane a static dependency of
            // the eager graph.
            {
              name: 'private-p2p',
              test: /(?:packages|@licio)[\\/]private-p2p[\\/]|node_modules[\\/](?:ts-mls|@noble|@hpke)[\\/]/,
              includeDependenciesRecursively: false,
              priority: 100,
            },
            // WS-R — the LCAP P2P TRANSPORT plane (optional WebRTC/IPFS +
            // courier carriers) plus `jsqr`, the QR carrier's decoder, reached
            // only through the lazy decode in `apps/web/src/lcap/transports/qr/`
            // (it would otherwise escape into a `jsQR-*` chunk on name alone).
            // `apps/web/src/lcap/transports/*` is likewise not captured: the
            // courier controls, the QR panel and the security page import it
            // statically.  The `-p2p` suffix in the test is what keeps the
            // `@licio/lcap` CORE out of the transport plane.
            {
              name: 'lcap-p2p',
              test: /(?:packages|@licio)[\\/]lcap-p2p[\\/]|node_modules[\\/]jsqr[\\/]/,
              includeDependenciesRecursively: false,
              priority: 100,
            },
            {
              name: 'react',
              test: /node_modules[\\/]react(?:-dom)?[\\/]/,
              includeDependenciesRecursively: false,
              priority: 50,
            },
          ],
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
      'Content-Security-Policy': contentSecurityPolicyHeader(),
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
