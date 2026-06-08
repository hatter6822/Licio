import { describe, expect, it } from 'vitest';
import { validateServiceWorkerReferences } from './check-service-worker.js';

describe('service worker reference validation', () => {
  it('allows relative worker dependencies and inert documentation URLs', () => {
    expect(
      validateServiceWorkerReferences([
        {
          path: 'workbox.js',
          content:
            'importScripts("./workbox-local.js"); console.warn("Learn more at https://bit.ly/wb-precache");',
        },
      ]),
    ).toEqual([]);
  });

  it('rejects external executable dependencies and network requests', () => {
    expect(
      validateServiceWorkerReferences([
        {
          path: 'sw.js',
          content: 'importScripts("https://cdn.example/sw.js"); fetch("https://api.example/data");',
        },
      ]),
    ).toEqual([
      expect.objectContaining({ kind: 'external importScripts dependency' }),
      expect.objectContaining({ kind: 'external fetch request' }),
    ]);
  });

  it('rejects external precache URLs', () => {
    expect(
      validateServiceWorkerReferences([
        {
          path: 'sw.js',
          content: 'precacheAndRoute([{url:"https://cdn.example/app.js",revision:null}]);',
        },
      ]),
    ).toEqual([expect.objectContaining({ kind: 'external precache URL' })]);
  });
});
