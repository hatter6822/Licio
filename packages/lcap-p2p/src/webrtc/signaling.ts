// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Server-blind WebRTC signaling envelope (OFFLINE_SPEC §16.3, §19.1, §26.4,
// WS-R.15.6a).  Two members exchange SDP/ICE through the existing Licio HTTPS API,
// but the server is a DUMB rendezvous: it routes an OPAQUE, end-to-end-encrypted blob
// between two opaque peer keys and never parses SDP/ICE, never reads a peer IP, and
// logs only the ciphertext.  ICE candidates / peer IPs are a §26.4 live-connection
// property of the direct browser-to-browser channel only — they NEVER appear in this
// envelope (a static + runtime check, WS-R.15.6a acceptance, proves it).
//
// The seal is AES-256-GCM under a key the two members share out of band (WS-S owns the
// real key schedule; here LCAP only carries the opaque blob).  The AAD binds the seal
// to (room, from, to) so a captured envelope cannot be replayed into another room or
// peer pair.

import { z } from 'zod';

const bytesSchema = z.custom<Uint8Array>(
  (v) => v instanceof Uint8Array || Object.prototype.toString.call(v) === '[object Uint8Array]',
  { message: 'expected a Uint8Array' },
);

/** The wire envelope the server forwards verbatim — every field is opaque to it. */
export const signalEnvelopeV2Schema = z
  .object({
    v: z.literal(2),
    /** Which room's rendezvous (an opaque one-way hash; never a real room id). */
    room_id_hash: bytesSchema,
    /** The opaque recipient peer key (a device-key hash; never an IP, §19.1). */
    to: z.string().min(1),
    /** The opaque sender peer key. */
    from: z.string().min(1),
    /** AES-GCM nonce (96-bit). */
    nonce: bytesSchema,
    /** The E2E-sealed SDP/ICE payload — opaque ciphertext to the server. */
    ciphertext: bytesSchema,
  })
  .strict();

export type SignalEnvelopeV2 = z.infer<typeof signalEnvelopeV2Schema>;

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.subtle?.encrypt !== 'function') {
    throw new Error('WebCrypto (crypto.subtle) is unavailable');
  }
  return c.subtle;
}

/** Adapt a Uint8Array to the ArrayBuffer-backed view WebCrypto's BufferSource requires. */
function ab(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}

/** The AAD binding a seal to its routing context (room + peer pair). */
function aad(env: Pick<SignalEnvelopeV2, 'room_id_hash' | 'from' | 'to'>): Uint8Array {
  const prefix = new TextEncoder().encode('lcap:p2p:signal:v2');
  const from = new TextEncoder().encode(`|${env.from}|`);
  const to = new TextEncoder().encode(`${env.to}`);
  const out = new Uint8Array(prefix.length + env.room_id_hash.length + from.length + to.length);
  let o = 0;
  out.set(prefix, o);
  o += prefix.length;
  out.set(env.room_id_hash, o);
  o += env.room_id_hash.length;
  out.set(from, o);
  o += from.length;
  out.set(to, o);
  return out;
}

export interface SealParams {
  readonly roomIdHash: Uint8Array;
  readonly from: string;
  readonly to: string;
  /** The plaintext SDP/ICE offer or answer to seal. */
  readonly payload: Uint8Array;
  /** The shared member key (32 bytes for AES-256-GCM); provided by WS-S out of band. */
  readonly key: CryptoKey;
  /** Test-injectable nonce; a fresh random 96-bit nonce by default. */
  readonly nonce?: Uint8Array;
}

/** Seal an SDP/ICE payload into a server-opaque envelope (AES-256-GCM + bound AAD). */
export async function sealSignal(params: SealParams): Promise<SignalEnvelopeV2> {
  const nonce = params.nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const additionalData = aad({ room_id_hash: params.roomIdHash, from: params.from, to: params.to });
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: ab(nonce), additionalData: ab(additionalData) },
    params.key,
    ab(params.payload),
  );
  return signalEnvelopeV2Schema.parse({
    v: 2,
    room_id_hash: params.roomIdHash,
    to: params.to,
    from: params.from,
    nonce,
    ciphertext: new Uint8Array(ct),
  });
}

/** Open a sealed envelope; throws if the AAD/tag does not verify (wrong room/peer/key). */
export async function openSignal(env: SignalEnvelopeV2, key: CryptoKey): Promise<Uint8Array> {
  const additionalData = aad(env);
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: ab(env.nonce), additionalData: ab(additionalData) },
    key,
    ab(env.ciphertext),
  );
  return new Uint8Array(pt);
}

/** Import a raw 32-byte secret as an AES-256-GCM key (WS-S supplies the secret). */
export async function importSignalKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', ab(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
