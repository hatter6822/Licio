// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.3 — the membership-proving handshake (PRIVATE_SPEC §15.5).
//
// After a transport connects, the two peers exchange `HandshakeHello`s
// (protocol version + an ephemeral X25519 key + a fresh nonce), then each PROVES
// current-epoch room membership by signing a transcript with its room-valid
// device key (Ed25519).  A peer that cannot produce that signature is rejected
// BEFORE any block exchange.  The pairwise data-channel session key is derived
// from the ephemeral ECDH bound to the same transcript (`sync/secure-channel.ts`,
// the handshake label), so it is fresh per connection and epoch-bound.  The
// proof transcript binds the room-id commitment, epoch, protocol version, the
// signer's device id, and BOTH ephemeral keys + nonces — defeating replay,
// reflection, and cross-room confusion.

import { z } from 'zod';
import { type CanonicalValue, canonical } from '../crypto/canonical.js';
import { fromBase64Url, toBase64Url } from '../crypto/runtime.js';
import { signEd25519, verifyEd25519 } from '../crypto/signatures.js';
import { base64UrlSchema, privateIdSchema } from '../schemas/common.js';
import {
  CHANNEL_LABEL_HANDSHAKE,
  type ChannelTranscript,
  deriveChannelKey,
} from './secure-channel.js';

/** The current handshake protocol version (§15.5). */
export const HANDSHAKE_PROTOCOL_VERSION = 1;

/** The opening message each peer sends: version + ephemeral key + a fresh nonce. */
export const handshakeHelloSchema = z
  .object({
    schema: z.literal('licio.private.handshake_hello.v1'),
    protocol_version: z.number().int().min(1),
    author_device_id: privateIdSchema,
    ephemeral_public_key: base64UrlSchema,
    hello_nonce: base64UrlSchema,
  })
  .strict();
export type HandshakeHello = z.infer<typeof handshakeHelloSchema>;

export interface BuildHelloParams {
  readonly deviceId: string;
  readonly ephemeralPublicKey: Uint8Array;
  readonly helloNonce: Uint8Array;
  readonly protocolVersion?: number;
}

/** Build a peer's `HandshakeHello`. */
export function buildHandshakeHello(params: BuildHelloParams): HandshakeHello {
  return handshakeHelloSchema.parse({
    schema: 'licio.private.handshake_hello.v1',
    protocol_version: params.protocolVersion ?? HANDSHAKE_PROTOCOL_VERSION,
    author_device_id: params.deviceId,
    ephemeral_public_key: toBase64Url(params.ephemeralPublicKey),
    hello_nonce: toBase64Url(params.helloNonce),
  });
}

/** The room + epoch + protocol version both peers agree on for this handshake. */
export interface HandshakeContext {
  readonly protocolVersion: number;
  readonly roomIdCommitment: Uint8Array;
  readonly epoch: number;
}

/**
 * The proof message a peer signs with its device key.  The SIGNER is listed
 * first, then the peer — binding the signer's identity, both ephemeral keys, and
 * both nonces along with the room + epoch + protocol version.  A captured proof
 * cannot be replayed (different nonces/ephemeral keys), reflected (the signer's
 * device id is bound), or reused across rooms/epochs.
 */
function handshakeProofMessage(
  signer: HandshakeHello,
  peer: HandshakeHello,
  ctx: HandshakeContext,
): Uint8Array {
  const fields: CanonicalValue[] = [
    'licio-priv1.handshake-proof.v1',
    ctx.protocolVersion,
    ctx.roomIdCommitment,
    ctx.epoch,
    signer.author_device_id,
    fromBase64Url(signer.ephemeral_public_key),
    fromBase64Url(signer.hello_nonce),
    peer.author_device_id,
    fromBase64Url(peer.ephemeral_public_key),
    fromBase64Url(peer.hello_nonce),
  ];
  return canonical(fields);
}

/** Sign this peer's membership proof (self as signer, remote as peer). */
export function signHandshakeProof(
  deviceSigningKey: CryptoKey,
  selfHello: HandshakeHello,
  remoteHello: HandshakeHello,
  ctx: HandshakeContext,
): Promise<Uint8Array> {
  return signEd25519(deviceSigningKey, handshakeProofMessage(selfHello, remoteHello, ctx));
}

/** Verify the remote peer's membership proof against its device public key. */
export function verifyHandshakeProof(
  remoteDevicePublicKey: CryptoKey,
  remoteHello: HandshakeHello,
  localHello: HandshakeHello,
  ctx: HandshakeContext,
  signature: Uint8Array,
): Promise<boolean> {
  return verifyEd25519(
    remoteDevicePublicKey,
    handshakeProofMessage(remoteHello, localHello, ctx),
    signature,
  );
}

/**
 * Derive the pairwise data-channel session key: ephemeral ECDH bound to the
 * handshake transcript (room, epoch, protocol version, both ephemeral keys)
 * under the handshake label.  Fresh per connection; both peers agree.
 */
export function deriveHandshakeSessionKey(
  myEphemeralPrivateKey: CryptoKey,
  peerEphemeralPublicKeyRaw: Uint8Array,
  localHello: HandshakeHello,
  remoteHello: HandshakeHello,
  ctx: HandshakeContext,
): Promise<Uint8Array> {
  const transcript: ChannelTranscript = {
    protocolVersion: ctx.protocolVersion,
    roomIdCommitment: ctx.roomIdCommitment,
    epoch: ctx.epoch,
    ephemeralPublicKeyA: fromBase64Url(localHello.ephemeral_public_key),
    ephemeralPublicKeyB: fromBase64Url(remoteHello.ephemeral_public_key),
  };
  return deriveChannelKey(
    myEphemeralPrivateKey,
    peerEphemeralPublicKeyRaw,
    transcript,
    CHANNEL_LABEL_HANDSHAKE,
  );
}

export type HandshakeRejection =
  | 'protocol_version_mismatch'
  | 'self_handshake'
  | 'unknown_device'
  | 'device_not_active'
  | 'proof_invalid';

export type HandshakeVerifyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: HandshakeRejection;
    };

/** What the reducer's membership state resolves for a claimed device id. */
export interface DeviceResolution {
  readonly publicKey: CryptoKey;
  /** Whether the device existed and was not removed at the handshake epoch. */
  readonly activeAtEpoch: boolean;
}

export interface VerifyPeerHandshakeParams {
  readonly localHello: HandshakeHello;
  readonly remoteHello: HandshakeHello;
  readonly remoteProofSignature: Uint8Array;
  readonly ctx: HandshakeContext;
  /** Resolve the remote device's public key + current-epoch active status. */
  resolveDevice(deviceId: string): DeviceResolution | undefined;
}

/**
 * §15.5 — verify the remote peer before any block exchange: protocol-version
 * agreement, no self/reflected handshake, the remote device is registered AND
 * active at the epoch, and its membership proof verifies.  Fails closed with a
 * typed reason at the first failed check.
 */
export async function verifyPeerHandshake(
  params: VerifyPeerHandshakeParams,
): Promise<HandshakeVerifyResult> {
  const { localHello, remoteHello, ctx } = params;
  if (
    remoteHello.protocol_version !== ctx.protocolVersion ||
    localHello.protocol_version !== ctx.protocolVersion
  ) {
    return { ok: false, reason: 'protocol_version_mismatch' };
  }
  if (remoteHello.author_device_id === localHello.author_device_id) {
    return { ok: false, reason: 'self_handshake' };
  }
  const device = params.resolveDevice(remoteHello.author_device_id);
  if (!device) return { ok: false, reason: 'unknown_device' };
  if (!device.activeAtEpoch) return { ok: false, reason: 'device_not_active' };
  const valid = await verifyHandshakeProof(
    device.publicKey,
    remoteHello,
    localHello,
    ctx,
    params.remoteProofSignature,
  );
  return valid ? { ok: true } : { ok: false, reason: 'proof_invalid' };
}
