// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2b — the service worker's verify-before-activate refusal must actually
// REFUSE, in the worker it really ships in.  `public/sw-push.js` never runs
// alone: `vite-plugin-pwa` (workbox-build) emits `importScripts('sw-push.js')`
// followed by the template's OWN unconditional
// `addEventListener('message', … 'SKIP_WAITING' === … self.skipWaiting())`.
// A bare `return` from our handler therefore declines nothing — the co-resident
// generated listener activates the unverified bundle anyway.  These tests
// reproduce that co-residency exactly: load the real file into a sandbox, then
// register the generated listener AFTER it, and assert the refusal still holds.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://licio.test';

function readSwPushSource(): string {
  // cwd is the repo root or apps/web depending on the runner — probe both.
  const candidates = [
    resolve(process.cwd(), 'apps/web/public/sw-push.js'),
    resolve(process.cwd(), 'public/sw-push.js'),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // try the next root
    }
  }
  throw new Error('could not locate apps/web/public/sw-push.js');
}

/** The worker global: a REAL EventTarget, so `stopImmediatePropagation` is the
 *  browser's own semantics rather than a hand-rolled approximation. */
class WorkerGlobalStub extends EventTarget {
  readonly location = { origin: ORIGIN, href: `${ORIGIN}/sw.js` };
  readonly skipWaiting = vi.fn();
}

/**
 * Load the real `sw-push.js` into a sandbox and then register the listener
 * workbox-build's template appends after its `importScripts` — the exact
 * registration ORDER of the shipped `dist/sw.js`.
 */
function bootWorker(): WorkerGlobalStub {
  const self = new WorkerGlobalStub();
  runInNewContext(readSwPushSource(), { self, indexedDB: undefined, clients: undefined });
  self.addEventListener('message', (event) => {
    const data = (event as MessageEvent).data;
    if (data && data.type === 'SKIP_WAITING') self.skipWaiting();
  });
  return self;
}

function post(self: WorkerGlobalStub, data: unknown, origin = ORIGIN): void {
  self.dispatchEvent(new MessageEvent('message', { data, origin }));
}

describe('sw-push.js SKIP_WAITING gate (WS-S.10.2b)', () => {
  it('activates on an ungated SKIP_WAITING (the public fast path)', () => {
    const self = bootWorker();
    post(self, { type: 'SKIP_WAITING' });
    // Both listeners run on the ACCEPT path (idempotent, as in the real worker).
    expect(self.skipWaiting).toHaveBeenCalled();
  });

  it('activates a gated message that carries the verified flag', () => {
    const self = bootWorker();
    post(self, { type: 'SKIP_WAITING', privateBundleGated: true, privateBundleVerified: true });
    // Both listeners run on the ACCEPT path (idempotent, as in the real worker).
    expect(self.skipWaiting).toHaveBeenCalled();
  });

  it('REFUSES a gated-but-unverified message even though workbox also listens', () => {
    const self = bootWorker();
    post(self, { type: 'SKIP_WAITING', privateBundleGated: true, privateBundleVerified: false });
    expect(self.skipWaiting).not.toHaveBeenCalled();
  });

  it('REFUSES a gated message with the verified flag ABSENT (fail-closed)', () => {
    const self = bootWorker();
    post(self, { type: 'SKIP_WAITING', privateBundleGated: true });
    expect(self.skipWaiting).not.toHaveBeenCalled();
  });

  it('REFUSES a cross-origin SKIP_WAITING, generated listener included', () => {
    const self = bootWorker();
    post(self, { type: 'SKIP_WAITING' }, 'https://attacker.example');
    expect(self.skipWaiting).not.toHaveBeenCalled();
  });
});
