// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
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

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: '/index.html',
      },
      manifest: {
        name: 'Licio',
        short_name: 'Licio',
        display: 'standalone',
        theme_color: '#1a1a2e',
        background_color: '#0f0f23',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
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
    proxy: {
      '/api': {
        target:
          process.env['DEV_HTTPS'] === 'true' ? 'https://localhost:3001' : 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  preview: {
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
        'trusted-types default dompurify',
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
