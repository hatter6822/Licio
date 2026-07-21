// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dedicated Web Worker for the sign-up proof-of-work solve (WS-D bot-prevention
// layer 1): keeps the SHA-256 brute-force off the main thread so the create-
// account form stays responsive.  Same-origin module worker (CSP worker-src
// 'self'); computes over server-supplied random bytes only — no user data ever
// enters this worker.  Imports ONLY the dependency-free solve module so the
// worker chunk stays tiny (never a duplicate of the API-client graph).
import { solvePowNumber } from './pow-solve.js';

interface SolveRequest {
  salt: string;
  target: string;
  max_number: number;
}

self.addEventListener('message', (event: MessageEvent<SolveRequest>) => {
  void (async () => {
    try {
      const number = await solvePowNumber(event.data);
      self.postMessage({ ok: true as const, number });
    } catch {
      self.postMessage({ ok: false as const });
    }
  })();
});
