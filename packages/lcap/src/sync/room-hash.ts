// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The privacy-scoped `room_id_hash` used in sync frontiers (OFFLINE_SPEC §16.2,
// §23.1).  Frontiers key rooms by this hash rather than the room id, and BOTH peers
// must derive it identically for their checkpoint frontiers to align — so the
// derivation lives in the shared protocol core, not in any one binding.
//
// It is a domain-separated SHA-256 over the network id + room id, with the inputs
// length-unambiguously encoded (a JSON 2-tuple) so distinct (network, room) pairs
// never collide.  Note: the hash is deterministic, so a low-entropy room id remains
// guessable by an observer of the frontier — the §21.4 metadata-protection review
// (WS-R.14) tracks hardening this (e.g. a network-scoped salt) where required.

import { sha256 } from '../cid/index.js';

const ROOM_HASH_DOMAIN = 'lcap:room-id-hash:v1';

/** Derive the `room_id_hash` for `(networkId, roomId)` (shared by client + server). */
export async function roomIdHash(networkId: string, roomId: string): Promise<Uint8Array> {
  const input = new TextEncoder().encode(ROOM_HASH_DOMAIN + JSON.stringify([networkId, roomId]));
  return sha256(input);
}
