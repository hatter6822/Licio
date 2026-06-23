// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.2 — encrypted WebRTC signaling + relay-only mode (PRIVATE_SPEC §15.4).
//
// WebRTC signaling messages (SDP offers/answers, ICE candidates) are E2E-
// encrypted under the pairwise signaling channel key (`sync/secure-channel.ts`)
// BEFORE they reach the server, which routes only opaque `EncryptedSignal`
// blobs — room/sender/recipient blind ids + ciphertext + a short expiry — and
// can read NO SDP/ICE.  The AEAD AAD binds those routing fields, so a blob
// cannot be re-pointed at a different room or recipient, and the channel key
// (transcript-bound to room-id commitment + epoch) prevents cross-room
// confusion.  Relay-only transport mode suppresses IP-revealing ICE candidate
// types so members need not reveal their network address to one another.

import { z } from 'zod';
import { aeadOpen, aeadSeal } from '../crypto/aead.js';
import { type CanonicalValue, canonical, decodeCanonical } from '../crypto/canonical.js';
import { fromBase64Url, toBase64Url } from '../crypto/runtime.js';
import { base64UrlSchema, ciphertextBase64Schema } from '../schemas/common.js';

// --- the signaling payload (E2E plaintext, never seen by the server) ---------

/** The kinds of signaling message carried on the channel (§15.4). */
export const SIGNAL_KINDS = ['offer', 'answer', 'ice', 'bye'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/**
 * The decrypted signaling payload: an SDP offer/answer, a single ICE candidate,
 * or a `bye`.  Strictly typed so a peer cannot smuggle an unexpected shape;
 * offer/answer require `sdp`, `ice` requires `ice_candidate`.
 */
export const signalingPayloadSchema = z
  .object({
    schema: z.literal('licio.private.signaling_payload.v1'),
    kind: z.enum(SIGNAL_KINDS),
    sdp: z.string().min(1).max(64_000).optional(),
    ice_candidate: z.string().min(1).max(2_000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.kind === 'offer' || v.kind === 'answer') && v.sdp === undefined) {
      ctx.addIssue({ code: 'custom', path: ['sdp'], message: 'offer/answer requires an SDP' });
    }
    if (v.kind === 'ice' && v.ice_candidate === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['ice_candidate'],
        message: 'ice requires a candidate',
      });
    }
  });
export type SignalingPayload = z.infer<typeof signalingPayloadSchema>;

// --- the opaque server-routed blob (§15.4) ----------------------------------

/** The ONLY thing the server routes/sees: opaque blind ids + ciphertext + TTL. */
export const encryptedSignalSchema = z
  .object({
    room_blind_id: base64UrlSchema,
    sender_blind_id: base64UrlSchema,
    recipient_blind_id: base64UrlSchema,
    ciphertext: ciphertextBase64Schema,
    expires_at: z.number().int().nonnegative(),
  })
  .strict();
export type EncryptedSignal = z.infer<typeof encryptedSignalSchema>;

/** The routing fields bound into the signal AEAD (so a blob cannot be re-pointed
 *  at a different room/sender/recipient/expiry). */
export interface SignalRouting {
  readonly roomBlindId: string;
  readonly senderBlindId: string;
  readonly recipientBlindId: string;
  readonly expiresAt: number;
}

function signalAad(routing: SignalRouting): Uint8Array {
  return canonical([
    'licio-priv1.signal',
    routing.roomBlindId,
    routing.senderBlindId,
    routing.recipientBlindId,
    routing.expiresAt,
  ]);
}

function serializeSignalingPayload(p: SignalingPayload): CanonicalValue {
  // `canonical` omits `undefined`-valued keys, so absent optional fields drop out
  // of the encoding (and round-trip back as absent).
  return {
    schema: p.schema,
    kind: p.kind,
    sdp: p.sdp,
    ice_candidate: p.ice_candidate,
  };
}

/**
 * Seal a signaling payload into an `EncryptedSignal` under the pairwise channel
 * key, AAD-bound to its routing fields.  The server stores/forwards the result
 * without reading the SDP/ICE inside.
 */
export async function sealSignal(
  payload: SignalingPayload,
  channelKey: Uint8Array,
  routing: SignalRouting,
): Promise<EncryptedSignal> {
  const validated = signalingPayloadSchema.parse(payload);
  const sealed = await aeadSeal(
    channelKey,
    canonical(serializeSignalingPayload(validated)),
    signalAad(routing),
  );
  return encryptedSignalSchema.parse({
    room_blind_id: routing.roomBlindId,
    sender_blind_id: routing.senderBlindId,
    recipient_blind_id: routing.recipientBlindId,
    ciphertext: toBase64Url(sealed),
    expires_at: routing.expiresAt,
  });
}

/**
 * Open an `EncryptedSignal` under the pairwise channel key.  The AAD is rebuilt
 * from the blob's OWN routing fields, so a tampered field fails closed; the
 * recovered payload is strictly re-validated.
 */
export async function openSignal(
  signal: EncryptedSignal,
  channelKey: Uint8Array,
): Promise<SignalingPayload> {
  const aad = signalAad({
    roomBlindId: signal.room_blind_id,
    senderBlindId: signal.sender_blind_id,
    recipientBlindId: signal.recipient_blind_id,
    expiresAt: signal.expires_at,
  });
  const plaintext = await aeadOpen(channelKey, fromBase64Url(signal.ciphertext), aad);
  return signalingPayloadSchema.parse(decodeCanonical(plaintext));
}

// --- relay-only transport mode (§15.4) --------------------------------------

/** §15.4 — the room's transport mode (relay-only hides peer IPs from members). */
export const TRANSPORT_MODES = ['relay_only', 'direct_allowed'] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

/** The WebRTC ICE candidate types (RFC 8445 §5.1.1).  `host`/`srflx`/`prflx`
 *  reveal the peer's IP; `relay` (a TURN-allocated address) does not. */
export const ICE_CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay'] as const;
export type IceCandidateType = (typeof ICE_CANDIDATE_TYPES)[number];

/** Parse the `typ <type>` token from an ICE candidate line, or `undefined`. */
export function iceCandidateType(candidate: string): IceCandidateType | undefined {
  const match = /\btyp\s+(host|srflx|prflx|relay)\b/.exec(candidate);
  return (match?.[1] as IceCandidateType | undefined) ?? undefined;
}

/**
 * §15.4 — whether an ICE candidate of `candidateType` may be sent under `mode`.
 * In relay-only mode ONLY relay (TURN) candidates are permitted; the IP-
 * revealing host/srflx/prflx types are suppressed.  An unknown/unparseable type
 * is suppressed in relay-only mode (fail closed).
 */
export function iceCandidateAllowed(
  mode: TransportMode,
  candidateType: IceCandidateType | undefined,
): boolean {
  return mode === 'direct_allowed' || candidateType === 'relay';
}

/**
 * Filter raw ICE candidate lines to those permitted under `mode` — the §15.4
 * relay-only IP-suppression applied before any candidate is signaled to a peer.
 */
export function filterIceCandidatesForMode(
  mode: TransportMode,
  candidates: readonly string[],
): string[] {
  if (mode === 'direct_allowed') return [...candidates];
  return candidates.filter((c) => iceCandidateAllowed(mode, iceCandidateType(c)));
}
