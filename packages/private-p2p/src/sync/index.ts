// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6 — the private-room P2P sync plane (PRIVATE_SPEC §15): the transport-
// independent, server-blind discovery + reconciliation logic.  Currently the
// §15.2/§15.3 blind rendezvous core (derivation, sealed announcements, the
// §15.3.1 authorization property, the §15.3.2 metadata mitigations); the live
// WebRTC carrier + server rendezvous endpoints (WS-S.6.2/6.6) build on it.

export * from './rendezvous.js';
export * from './secure-channel.js';
export * from './signaling.js';
