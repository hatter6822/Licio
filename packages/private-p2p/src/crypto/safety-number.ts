// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — safety-number (SAS) derivation for out-of-band device verification
// (PRIVATE_SPEC §15.5 / §20.4).  A safety number is a short, human-comparable
// string that two members read to each other over a TRUSTED out-of-band channel
// (in person, a verified call) to detect a man-in-the-middle on the P2P
// transport.  It is a deterministic, symmetric function of BOTH devices'
// LONG-TERM Ed25519 signing public keys plus the room-id commitment — never the
// ephemeral handshake/session key (which a MITM controls), so it detects a
// persistent MITM across reconnects.
//
// The construction mirrors Signal's NumericFingerprint (an iterated hash per
// device, truncated, then rendered as decimal-digit groups).  The iteration
// raises the cost of a brute-force search for a second key that produces the
// same truncated display.  We use the codebase's audited WebCrypto SHA-256
// (no hand-rolled crypto, §10.1 principle 10).

import { concatBytes, fromBase64Url, sha256, utf8 } from './runtime.js';

/** Domain separator — binds the SAS to this protocol + version (§10.2). */
const SAFETY_NUMBER_DOMAIN = utf8('licio.private-room.safety-number.v1');

/** Iterations per device (matches Signal's NumericFingerprint hardness). */
export const SAFETY_NUMBER_ITERATIONS = 5200;

/** Each device fingerprint is truncated to this many bytes before display. */
const FINGERPRINT_BYTES = 30;

/** Digits rendered per device (6 five-byte chunks × 5 digits). */
const DIGITS_PER_DEVICE = 30;

/** Total safety-number digits (both devices). */
export const SAFETY_NUMBER_DIGITS = DIGITS_PER_DEVICE * 2;

/** Display group size. */
const GROUP_SIZE = 5;

/** A device's stable identity inputs to the safety number. */
export interface SafetyNumberDevice {
  /** The stable device id (binds the fingerprint to a device, not just a key). */
  readonly deviceId: string;
  /** The device's long-term Ed25519 signing public key, base64url (raw 32 bytes). */
  readonly signingPublicKey: string;
}

export interface SafetyNumber {
  /** The full numeric safety number (60 decimal digits). */
  readonly value: string;
  /** The same value split into display groups of five digits. */
  readonly groups: readonly string[];
}

/** Bytewise total order (so the SAS is symmetric regardless of who is local). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * The iterated per-device fingerprint:
 *   h₀  = SHA-256(domain ‖ roomIdCommitment ‖ pubKey ‖ deviceId)
 *   hₙ₊₁ = SHA-256(hₙ ‖ pubKey)         (×SAFETY_NUMBER_ITERATIONS)
 * truncated to 30 bytes.  Binding `roomIdCommitment` scopes the SAS to the room;
 * mixing `pubKey` every round ties the hardness to the key being verified.
 */
async function deviceFingerprint(
  roomIdCommitment: Uint8Array,
  pubKey: Uint8Array,
  deviceId: string,
): Promise<Uint8Array> {
  let h = await sha256(concatBytes(SAFETY_NUMBER_DOMAIN, roomIdCommitment, pubKey, utf8(deviceId)));
  for (let i = 0; i < SAFETY_NUMBER_ITERATIONS; i++) {
    h = await sha256(concatBytes(h, pubKey));
  }
  return h.slice(0, FINGERPRINT_BYTES);
}

/** Encode a 30-byte fingerprint as 30 decimal digits (6 chunks of 5 bytes). */
function fingerprintDigits(fingerprint: Uint8Array): string {
  let digits = '';
  for (let chunk = 0; chunk < FINGERPRINT_BYTES / 5; chunk++) {
    // A 40-bit value fits exactly in a JS safe integer (< 2^53); combine without
    // 32-bit bitwise overflow by multiplying.
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * 256 + (fingerprint[chunk * 5 + i] as number);
    digits += String(value % 100000).padStart(5, '0');
  }
  return digits;
}

/**
 * Compute the safety number for the local⇄remote device pair.  Symmetric: both
 * peers compute the IDENTICAL value because the two fingerprints are sorted
 * bytewise before rendering.  A different key, device id, or room yields a
 * different number.
 */
export async function computeSafetyNumber(params: {
  readonly roomIdCommitment: Uint8Array;
  readonly local: SafetyNumberDevice;
  readonly remote: SafetyNumberDevice;
}): Promise<SafetyNumber> {
  const fpLocal = await deviceFingerprint(
    params.roomIdCommitment,
    fromBase64Url(params.local.signingPublicKey),
    params.local.deviceId,
  );
  const fpRemote = await deviceFingerprint(
    params.roomIdCommitment,
    fromBase64Url(params.remote.signingPublicKey),
    params.remote.deviceId,
  );
  const [lo, hi] = compareBytes(fpLocal, fpRemote) <= 0 ? [fpLocal, fpRemote] : [fpRemote, fpLocal];
  const value = fingerprintDigits(lo) + fingerprintDigits(hi);
  const groups: string[] = [];
  for (let i = 0; i < value.length; i += GROUP_SIZE) groups.push(value.slice(i, i + GROUP_SIZE));
  return { value, groups };
}
