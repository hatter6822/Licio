// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.1a/6.1b — blind rendezvous discovery (PRIVATE_SPEC §15.2, §15.3,
// §15.3.1, §15.3.2).
//
// Knowledge of the per-epoch `rendezvous_key` (one of the five §10.2 room keys)
// IS the rendezvous capability (§15.3.1): only a current-epoch member can
// compute a room's `room_blind_id` to announce or poll; the server performs NO
// ACL (it cannot map a blind id back to a room or account); and a removed member
// loses the capability at the next epoch rotation (WS-S.3.1b changes the key).
// The server ever sees ONLY opaque blind ids + sealed announcement ciphertext +
// a short TTL.  Blind ids are HMAC-SHA256 over a CANONICAL-encoded message (never
// `||` concatenation), so a field-boundary ambiguity can never collide two
// distinct (epoch, bucket) windows.
//
// §15.3.2 metadata-leakage mitigations (and their honest residual): coarse
// `time_bucket`s + per-peer announce jitter blunt the "approximate concurrent
// size" a server could infer from distinct `peer_blind_id`s under one
// `room_blind_id`; cover/dummy records let a high-risk room publish decoys the
// server cannot distinguish; high-risk rooms can disable Licio blind rendezvous
// entirely in favour of member/manual discovery (so Licio sees nothing).  The
// residual leakage is documented in the §5.4 metadata table (the honest-limits
// copy SSOT) — this module implements the mitigations, it does not erase the
// residual.

import { z } from 'zod';
import { aeadOpen, aeadSeal } from '../crypto/aead.js';
import { type CanonicalValue, canonical, decodeCanonical } from '../crypto/canonical.js';
import { hkdfExpandLabel } from '../crypto/hkdf.js';
import { fromBase64Url, hmacSha256, randomBytes, toBase64Url } from '../crypto/runtime.js';
import { base64UrlSchema, privateIdSchema } from '../schemas/common.js';

// --- discovery modes + risk steering (§15.2, §15.3.2) -----------------------

/** §15.2 — the four discovery modes. */
export const RENDEZVOUS_DISCOVERY_MODES = [
  'local_mdns',
  'licio_blind',
  'member_rendezvous',
  'manual',
] as const;
export type RendezvousDiscoveryMode = (typeof RENDEZVOUS_DISCOVERY_MODES)[number];

/** A room's rendezvous risk posture (§15.3.2). */
export const RENDEZVOUS_RISK_TIERS = ['standard', 'high'] as const;
export type RendezvousRiskTier = (typeof RENDEZVOUS_RISK_TIERS)[number];

/**
 * The discovery modes a room of a given risk tier MAY use (§15.3.2).  A
 * high-risk room disables Licio blind rendezvous entirely (so Licio never sees a
 * blind id for it) and uses member/manual discovery only; `local_mdns` stays
 * available in both tiers because it never touches Licio.
 */
export function allowedDiscoveryModes(riskTier: RendezvousRiskTier): RendezvousDiscoveryMode[] {
  return riskTier === 'high'
    ? ['local_mdns', 'member_rendezvous', 'manual']
    : [...RENDEZVOUS_DISCOVERY_MODES];
}

// --- TTL + coarse time bucket (§15.3.2, §5.4) -------------------------------

/** §15.3.2 — the rendezvous-record TTL bounds (5–30 minutes). */
export const RENDEZVOUS_MIN_TTL_MS = 5 * 60 * 1000;
export const RENDEZVOUS_MAX_TTL_MS = 30 * 60 * 1000;

/** §15.3.2 — the default coarse `time_bucket` granularity (15 minutes). */
export const RENDEZVOUS_DEFAULT_BUCKET_MS = 15 * 60 * 1000;

/** §15.3.1 — the server's bounded poll response size (never an existence oracle:
 *  the server returns ≤ this many records whether or not the blind id is known). */
export const RENDEZVOUS_MAX_RECORDS_PER_POLL = 256;

/** Clamp a requested TTL into the §15.3.2 `[MIN, MAX]` window (floored to ms). */
export function clampRendezvousTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) throw new RangeError(`clampRendezvousTtl: invalid ttl ${ttlMs}`);
  return Math.min(RENDEZVOUS_MAX_TTL_MS, Math.max(RENDEZVOUS_MIN_TTL_MS, Math.floor(ttlMs)));
}

/**
 * The coarse `time_bucket` index for `nowMs` at `bucketMs` granularity — a
 * deliberately low-resolution clock (§5.4): all announcements in the same window
 * share a bucket, so the server cannot read a precise announce time.
 */
export function rendezvousTimeBucket(
  nowMs: number,
  bucketMs: number = RENDEZVOUS_DEFAULT_BUCKET_MS,
): number {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new RangeError(`rendezvousTimeBucket: invalid now ${nowMs}`);
  }
  if (!Number.isInteger(bucketMs) || bucketMs <= 0) {
    throw new RangeError(`rendezvousTimeBucket: invalid bucket ${bucketMs}`);
  }
  return Math.floor(nowMs / bucketMs);
}

// --- blind-id derivation (§15.2) --------------------------------------------

function blindId(rendezvousKey: Uint8Array, message: CanonicalValue): Promise<Uint8Array> {
  return hmacSha256(rendezvousKey, canonical(message));
}

/**
 * `room_blind_id = HMAC-SHA256(rendezvous_key, canonical(["room", epoch,
 * time_bucket]))`, base64url-encoded.  Deterministic for `(rendezvous_key,
 * epoch, time_bucket)`; every current-epoch member computes the SAME id, so they
 * find each other without the server learning the room.
 */
export async function deriveRoomBlindId(
  rendezvousKey: Uint8Array,
  epoch: number,
  timeBucket: number,
): Promise<string> {
  return toBase64Url(await blindId(rendezvousKey, ['room', epoch, timeBucket]));
}

/**
 * `peer_blind_id = HMAC-SHA256(rendezvous_key, canonical(["peer", device_id,
 * epoch, time_bucket]))`, base64url-encoded — a per-device announce handle under
 * the room id, distinct per device but unlinkable to the device id without the
 * key.
 */
export async function derivePeerBlindId(
  rendezvousKey: Uint8Array,
  deviceId: string,
  epoch: number,
  timeBucket: number,
): Promise<string> {
  return toBase64Url(await blindId(rendezvousKey, ['peer', deviceId, epoch, timeBucket]));
}

// --- sealed announcement (§15.3) --------------------------------------------

/**
 * The plaintext a `BlindRendezvousRecord` carries, sealed under the
 * `rendezvous_key`: enough to bootstrap the §15.4 encrypted signaling channel.
 * `signaling_public_key` is an ephemeral public key; `transport_hints` are
 * opaque (e.g. relay candidates) and never an IP the server can read — they live
 * INSIDE the seal.
 */
export const rendezvousAnnouncementSchema = z
  .object({
    schema: z.literal('licio.private.rendezvous_announcement.v1'),
    peer_device_id: privateIdSchema,
    signaling_public_key: base64UrlSchema,
    transport_hints: z.array(z.string().min(1).max(256)).max(16).default([]),
  })
  .strict();
export type RendezvousAnnouncement = z.infer<typeof rendezvousAnnouncementSchema>;

const ANNOUNCE_KEY_LABEL = 'rendezvous-announce.v1';
const ANNOUNCE_KEY_LENGTH = 32;
const EMPTY_CONTEXT = new Uint8Array(0);

/** Derive the announcement AEAD key from `rendezvous_key` — domain-separated
 *  from the HMAC blind-id use by the distinct `HkdfLabel` framing (§10.2). */
function deriveAnnounceKey(rendezvousKey: Uint8Array): Promise<Uint8Array> {
  return hkdfExpandLabel(rendezvousKey, ANNOUNCE_KEY_LABEL, EMPTY_CONTEXT, ANNOUNCE_KEY_LENGTH);
}

/** The canonical AAD binding a sealed announcement to its record (so the
 *  ciphertext cannot be lifted into a different blind id / expiry). */
function announcementAad(roomBlindId: string, peerBlindId: string, expiresAt: number): Uint8Array {
  return canonical(['licio-priv1.rendezvous-announce', roomBlindId, peerBlindId, expiresAt]);
}

function serializeAnnouncement(a: RendezvousAnnouncement): CanonicalValue {
  return {
    schema: a.schema,
    peer_device_id: a.peer_device_id,
    signaling_public_key: a.signaling_public_key,
    transport_hints: [...a.transport_hints],
  };
}

/** §15.3 — the only thing the server stores for an unlisted/detached room: two
 *  opaque blind ids, the sealed announcement, and a short expiry. */
export const blindRendezvousRecordSchema = z
  .object({
    room_blind_id: base64UrlSchema,
    peer_blind_id: base64UrlSchema,
    encrypted_announcement: base64UrlSchema,
    expires_at: z.number().int().nonnegative(),
  })
  .strict();
export type BlindRendezvousRecord = z.infer<typeof blindRendezvousRecordSchema>;

export interface BuildRendezvousRecordParams {
  readonly rendezvousKey: Uint8Array;
  readonly epoch: number;
  readonly timeBucket: number;
  readonly deviceId: string;
  readonly announcement: RendezvousAnnouncement;
  readonly nowMs: number;
  /** Defaults to the §15.3.2 maximum (30 min); clamped into `[MIN, MAX]`. */
  readonly ttlMs?: number;
}

/**
 * Build a `BlindRendezvousRecord` for the current `(epoch, time_bucket)`: derive
 * the room + peer blind ids, seal the announcement under the announce key (AAD-
 * bound to the record), and set a clamped short TTL.
 */
export async function buildRendezvousRecord(
  params: BuildRendezvousRecordParams,
): Promise<BlindRendezvousRecord> {
  const announcement = rendezvousAnnouncementSchema.parse(params.announcement);
  const roomBlindId = await deriveRoomBlindId(
    params.rendezvousKey,
    params.epoch,
    params.timeBucket,
  );
  const peerBlindId = await derivePeerBlindId(
    params.rendezvousKey,
    params.deviceId,
    params.epoch,
    params.timeBucket,
  );
  const expiresAt = params.nowMs + clampRendezvousTtl(params.ttlMs ?? RENDEZVOUS_MAX_TTL_MS);
  const announceKey = await deriveAnnounceKey(params.rendezvousKey);
  const sealed = await aeadSeal(
    announceKey,
    canonical(serializeAnnouncement(announcement)),
    announcementAad(roomBlindId, peerBlindId, expiresAt),
  );
  return blindRendezvousRecordSchema.parse({
    room_blind_id: roomBlindId,
    peer_blind_id: peerBlindId,
    encrypted_announcement: toBase64Url(sealed),
    expires_at: expiresAt,
  });
}

/**
 * Open a record's sealed announcement under the `rendezvous_key`.  The AAD binds
 * the record's blind ids + expiry, so a tampered/foreign record (including a
 * §15.3.2 cover record) fails closed; the recovered announcement is strictly
 * re-validated.
 */
export async function openRendezvousAnnouncement(
  record: BlindRendezvousRecord,
  rendezvousKey: Uint8Array,
): Promise<RendezvousAnnouncement> {
  const announceKey = await deriveAnnounceKey(rendezvousKey);
  const plaintext = await aeadOpen(
    announceKey,
    fromBase64Url(record.encrypted_announcement),
    announcementAad(record.room_blind_id, record.peer_blind_id, record.expires_at),
  );
  return rendezvousAnnouncementSchema.parse(decodeCanonical(plaintext));
}

/** Whether a record has expired at `nowMs` (the client filters these; the server
 *  must not return expired records, enforced with WS-S.6.6). */
export function isRendezvousRecordExpired(record: BlindRendezvousRecord, nowMs: number): boolean {
  return nowMs >= record.expires_at;
}

// --- §15.3.2 metadata mitigations -------------------------------------------

/**
 * Per-peer announce jitter: spread a member's announce time uniformly over
 * `[nowMs, nowMs + maxJitterMs]` so a server observing distinct `peer_blind_id`s
 * under one `room_blind_id` cannot infer "≈ N members online right now" from a
 * synchronized burst.  `random01` is an injected uniform in `[0, 1)` (the caller
 * passes a CSPRNG-derived value or a seeded RNG in tests).
 */
export function jitteredAnnounceTime(nowMs: number, maxJitterMs: number, random01: number): number {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new RangeError(`jitteredAnnounceTime: invalid now ${nowMs}`);
  }
  if (!Number.isFinite(maxJitterMs) || maxJitterMs < 0) {
    throw new RangeError(`jitteredAnnounceTime: invalid jitter ${maxJitterMs}`);
  }
  const clamped = Math.min(1, Math.max(0, random01));
  return Math.floor(nowMs + clamped * maxJitterMs);
}

/**
 * A §15.3.2 cover record: random blind ids + random-looking sealed bytes,
 * structurally indistinguishable from a genuine announcement to the server, so a
 * high-risk room can publish decoys that blunt size inference.  It opens for NO
 * member (the bytes are random, not a real seal — `openRendezvousAnnouncement`
 * fails closed), and carries the same TTL shape as a real record.
 */
export function buildCoverRecord(nowMs: number, ttlMs?: number): BlindRendezvousRecord {
  const expiresAt = nowMs + clampRendezvousTtl(ttlMs ?? RENDEZVOUS_MAX_TTL_MS);
  return blindRendezvousRecordSchema.parse({
    room_blind_id: toBase64Url(randomBytes(32)),
    peer_blind_id: toBase64Url(randomBytes(32)),
    // nonce(12) + a plausible small-announcement ciphertext+tag length.
    encrypted_announcement: toBase64Url(randomBytes(96)),
    expires_at: expiresAt,
  });
}
