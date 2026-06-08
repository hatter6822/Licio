import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClientEnv } from '@licio/shared/env/client';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type PluginOption, type ServerOptions } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

function loadExampleClientEnv(): Record<string, string> {
  const examplePath = join(process.cwd(), '../../.env.example');
  if (!existsSync(examplePath)) {
    return {};
  }
  return Object.fromEntries(
    readFileSync(examplePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('VITE_') && line.includes('='))
      .map((line) => {
        const separatorIndex = line.indexOf('=');
        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
      }),
  );
}

export default defineConfig(({ mode }) => {
  const clientEnv = { ...loadExampleClientEnv(), ...loadEnv(mode, process.cwd(), 'VITE_') };
  parseClientEnv(clientEnv);
  for (const [key, value] of Object.entries(clientEnv)) {
    process.env[key] ??= value;
  }

  const viteProcessEnv = process.env as NodeJS.ProcessEnv & { LOCAL_HTTPS?: string };
  const localHttps =
    viteProcessEnv.LOCAL_HTTPS === '1'
      ? {
          key: readFileSync(join(process.cwd(), '../../.certs/localhost-key.pem')),
          cert: readFileSync(join(process.cwd(), '../../.certs/localhost-cert.pem')),
        }
      : undefined;
  const server = {
    ...(localHttps === undefined ? {} : { https: localHttps }),
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  } satisfies ServerOptions;

  return {
    base: '/',
    plugins: [
      react() as PluginOption,
      tailwindcss() as PluginOption,
      VitePWA({
        registerType: 'prompt',
        injectRegister: false,
        scope: '/',
        manifest: {
          name: 'Licio',
          short_name: 'Licio',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          theme_color: '#111827',
          background_color: '#ffffff',
          icons: [
            {
              src: '/pwa-192.svg',
              sizes: '192x192',
              type: 'image/svg+xml',
              purpose: 'any maskable',
            },
            {
              src: '/pwa-512.svg',
              sizes: '512x512',
              type: 'image/svg+xml',
              purpose: 'any maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,ico,webmanifest}'],
          navigateFallback: '/index.html',
        },
      }) as PluginOption,
    ],
    build: {
      target: 'es2022',
      sourcemap: false,
      cssCodeSplit: true,
      manifest: true,
      rollupOptions: {
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
          manualChunks: {
            react: ['react', 'react-dom'],
          },
        },
      },
    },
    server,
  };
});
