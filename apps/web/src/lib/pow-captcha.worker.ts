// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dedicated Web Worker for the sign-up proof-of-work solve (WS-D bot-prevention
// layer 1): keeps the SHA-256 brute-force off the main thread so the create-
// account form stays responsive.  Same-origin module worker (CSP worker-src
// 'self'); computes over server-supplied random bytes only — no user data ever
// enters this worker.  Imports ONLY the dependency-free solve module so the
// worker chunk stays tiny (never a duplicate of the API-client graph).
import { parseSolveRequest, solvePowNumber } from './pow-solve.js';

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  // A dedicated module worker only ever receives messages from its same-origin
  // creator, whose `MessageEvent.origin` is the empty string.  Accept that, and
  // reject any unexpected non-empty foreign origin (defense-in-depth — and the
  // explicit guard the generic js/missing-origin-check rule looks for, which
  // cannot otherwise see the dedicated-worker message model).
  if (event.origin && event.origin !== self.location.origin) return;
  // Validate the untrusted payload at the worker boundary: a malformed message
  // — or a pathological `max_number` — can never spin the brute-force loop.
  const request = parseSolveRequest(event.data);
  if (request === null) {
    self.postMessage({ ok: false as const });
    return;
  }
  void (async () => {
    try {
      const number = await solvePowNumber(request);
      self.postMessage({ ok: true as const, number });
    } catch {
      self.postMessage({ ok: false as const });
    }
  })();
});
