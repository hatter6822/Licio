// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TEST-ONLY harness for the WP-9 real-browser carrier E2E
// (`e2e/private-carrier.realwebrtc.spec.ts`).  A raw `page.evaluate` cannot resolve the
// bare specifier `@licio/private-p2p` (Vite only rewrites specifiers inside modules IT
// serves), so the spec imports THIS `/src` module through the dev module graph instead.
//
// It re-exports the carrier (`connectPrivatePeer`, whose own `@licio/private-p2p` imports
// are type-only/erased) and exposes the crypto/protocol package via a DYNAMIC import
// (`loadP2p`) — so `check:private-p2p-split` stays green (no static value import) and the
// heavy chunk never enters the initial bundle.  Nothing in the app imports this file, so
// it is tree-shaken out of the production build.

export { connectPrivatePeer } from './connect-peer.js';
// `PrivateSyncSession` drives the §15.7 op-exchange over the carrier's `PeerChannel`; its
// `@licio/private-p2p` imports are type-only/erased, so re-exporting it keeps
// `check:private-p2p-split` green and the heavy chunk out of the initial bundle.
export { PrivateSyncSession, type SyncCodec } from './sync-session.js';

/** dead-exports-entry: this module is fetched by URL through the Vite dev module
 *  graph from `e2e/private-carrier.realwebrtc.spec.ts`, so no TypeScript import edge to it
 *  exists and binding resolution cannot see the call.
 *
 *  Dynamically load the code-split `@licio/private-p2p` chunk for the E2E harness. */
export function loadP2p(): Promise<typeof import('@licio/private-p2p')> {
  return import('@licio/private-p2p');
}
