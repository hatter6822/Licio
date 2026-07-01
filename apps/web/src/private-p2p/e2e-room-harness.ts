// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TEST-ONLY harness for the two-browser private-room E2E
// (`e2e/private-room-bff.realwebrtc.spec.ts`).  A raw `page.evaluate` cannot resolve the
// bare specifier `@licio/private-p2p`, so the spec imports THIS `/src` module through the
// Vite dev module graph instead (Vite rewrites specifiers only inside modules it serves).
//
// It re-exports the REAL `PrivateRoomSession` manager (the object the UI drives) + the §12.3
// join-grant (de)serializers, so the E2E exercises the ACTUAL create → invite → join →
// connect → converge flow over the REAL server-blind rendezvous (`/v1/private-rendezvous/*`,
// dev-proxied to the in-memory API) — not a hand-rolled bridge.  `PrivateRoomSession`'s
// `@licio/private-p2p` imports are type-only/erased + the heavy chunk loads via a DYNAMIC
// import, so `check:private-p2p-split` stays green and nothing here enters the production
// bundle (no app module imports this file → tree-shaken out).

export {
  PrivateRoomSession,
  parseJoinGrant,
  serializeJoinGrant,
} from './room-manager.js';

/** Dynamically load the code-split `@licio/private-p2p` chunk (for `roomStateCommitment`,
 *  used by the E2E to assert byte-identical convergence). */
export function loadP2p(): Promise<typeof import('@licio/private-p2p')> {
  return import('@licio/private-p2p');
}
