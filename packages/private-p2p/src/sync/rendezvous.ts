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
import {
  AES_GCM_NONCE_LENGTH,
  AES_GCM_TAG_LENGTH,
  aeadOpen,
  aeadSeal,
  PADDING_BUCKET_4K,
  PADDING_BUCKET_16K,
  padBody,
  selectPaddingPolicy,
  unpadBody,
} from '../crypto/aead.js';
import { type CanonicalValue, canonical, decodeCanonical } from '../crypto/canonical.js';
import { deriveX25519KeyPair, type X25519KeyPair } from '../crypto/ecdh.js';
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

/**
 * A device's §15.4 SIGNALLING IDENTITY for one `(room, epoch, time bucket)`, derived from the
 * rendezvous key: `seed = HMAC-SHA256(rendezvous_key, canonical(["signal-key", device_id, epoch,
 * time_bucket]))`, used as the X25519 private scalar.
 *
 * DETERMINISTIC, which fixes the ANNOUNCEMENT FAN-OUT.  `connectPrivatePeer` used to mint a FRESH
 * ephemeral per CALL, and a mesh member runs that call CONCURRENTLY, once per peer — so a device
 * dialling two peers published TWO live rendezvous slots, each lingering for the §15.3.2 TTL with no
 * retraction.  Measured: three live candidates for a single device, and roughly a dozen addresses a
 * minute that nobody answers at.  That contradicts `connect-peer.ts`'s own documented "one slot per
 * device per bucket" and fills the store with dead entries.  One identity per bucket makes the claim
 * true — `selectFreshestCandidates` collapses a device to one candidate by construction, and
 * re-announcing is idempotent.
 *
 * It is NOT what fixes the mesh flake; `deriveSignalAddress` carries that, and the split is measured
 * rather than assumed (the address change alone, with this per-call ephemeral still in place, passes
 * the mesh spec).  The two land together because this one is only SAFE alongside it.
 *
 * The dependency, concretely: with the old recipient-only address, one identity per device would
 * give a device a SINGLE inbound queue shared by every session it runs — the worst case of the
 * deliver-once destruction the address change exists to stop.
 *
 * It does NOT weaken §15.3 unlinkability: the key rotates with the time bucket exactly as
 * `derivePeerBlindId` does, it is derived under the room's rendezvous key (so only current-epoch
 * members can compute or correlate it), and cross-bucket values are unlinkable to the server for the
 * same reason the blind ids are.  Within a bucket a device was always linkable to itself anyway —
 * that IS the one-slot-per-device-per-bucket cap the Tier-2 pseudonym enforces.
 */
export async function deriveSignalingKeyPair(
  rendezvousKey: Uint8Array,
  deviceId: string,
  epoch: number,
  timeBucket: number,
): Promise<X25519KeyPair> {
  return deriveX25519KeyPair(
    await blindId(rendezvousKey, ['signal-key', deviceId, epoch, timeBucket]),
  );
}

/**
 * A PAIRWISE, DIRECTED §15.4 signaling-queue address:
 * `HMAC-SHA256(rendezvous_key, canonical(["signal", sender_ephemeral, recipient_ephemeral, epoch,
 * time_bucket]))`, base64url-encoded.
 *
 * The `signal/poll` drain is DELIVER-ONCE, so two live sessions on one device must never share an
 * inbound address: the first pump to poll would consume — and drop as un-openable — a signal meant
 * for the other session's channel key.  That is what the per-CALL ephemeral used to prevent, by
 * giving every session a distinct recipient key; keying on the recipient ALONE was sound only while
 * a device had one ephemeral per session.
 *
 * THE FAILURE THIS FIXES is a shared queue DESTROYING a third party's offer.  In a 3-peer mesh every
 * member dials every other at once, and each addresses the SAME (freshest) announcement of the member
 * it is dialling — so two offers land in ONE deliver-once queue.  The session that drains it can open
 * only the one matching its channel key; the other is dropped as un-openable AND the poll has already
 * cleared it, so it is gone rather than delayed.  That peer then waits out its dial deadline against
 * a view that has moved on (the `skipped a signal` warnings, on the member everyone dials at once).
 * Keying on the SENDER separates them: nothing is destroyed, and the second offer waits in the
 * mailbox for the session that can open it.
 *
 * Note this is exactly the property the previous recipient-only docstring CLAIMED — "gives every
 * pairwise channel its own queue" — and did not have.  It holds only while every session has its own
 * recipient ephemeral, which stops being true the moment two peers pick the same announcement.
 *
 * MEASURED, because the halves are not equally load-bearing and it would be easy to assert otherwise:
 * this change ALONE (with the old per-call ephemeral still in place) carries the mesh spec.
 * `deriveSignalingKeyPair` fixes a different, separately-measured defect — see its own note — and
 * depends on this one to be safe, since one identity per device with a recipient-only address would
 * give a device a single shared queue for ALL its sessions: the worst case of the bug above.
 *
 * DIRECTED — the sender's key comes first — so A→B and B→A are distinct queues and a peer can never
 * drain a signal it sent itself.  Both peers compute the same address for a direction from the two
 * public keys they already hold, so there is no extra round-trip.
 *
 * The cost is that a peer can no longer derive its inbound address BEFORE discovering the sender, so
 * it starts draining one poll later.  Nothing is lost: the queue is a server-side mailbox with a
 * TTL, not a live socket, and an offer sent before the answerer began draining is still there when
 * it does — the same property ICE candidates arriving ahead of their offer already rely on.
 */
export async function deriveSignalAddress(
  rendezvousKey: Uint8Array,
  senderSignalingPublicKey: Uint8Array,
  recipientSignalingPublicKey: Uint8Array,
  epoch: number,
  timeBucket: number,
): Promise<string> {
  return toBase64Url(
    await blindId(rendezvousKey, [
      'signal',
      toBase64Url(senderSignalingPublicKey),
      toBase64Url(recipientSignalingPublicKey),
      epoch,
      timeBucket,
    ]),
  );
}

// --- sealed announcement (§15.3) --------------------------------------------

/** A base64url value bounded to `max` chars.  The shared `base64UrlSchema`'s 16,384 cap is too loose
 *  for the fixed-size announcement fields: with all of them at that cap a valid announcement's
 *  canonical plaintext would exceed the §25.4 16 KiB padding bucket → the 'custom' bucket → a sealed
 *  record too large for the wire cap (PRIV-RENDEZVOUS-PADCAP).  Bounding each field to its realistic
 *  size (generously vs. the measured values — a 32-byte X25519 key is 43 chars, a Tier-2 BBS proof
 *  ~448, its 48-byte G1 pseudonym 64) keeps EVERY schema-valid announcement inside the 16 KiB bucket,
 *  so `RENDEZVOUS_SEALED_MAX_CHARS` always holds its sealed record and `buildRendezvousRecord` can
 *  never throw on a valid input. */
const boundedBase64Url = (max: number): z.ZodString =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, 'expected base64url (no padding)');

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
    // A 32-byte X25519 ephemeral public key base64url-encodes to 43 chars; 128 is generous headroom.
    signaling_public_key: boundedBase64Url(128),
    transport_hints: z.array(z.string().min(1).max(256)).max(16).default([]),
    /**
     * Tier-2 rendezvous cap (docs/private-p2p/TIER2-RENDEZVOUS-CAP.md §6.8) — the OPTIONAL
     * anonymous-credential proof, sealed INSIDE the announcement (only a member who can open
     * it sees the cap; the relay never does). A polling member verifies it under the room's
     * per-epoch issuer key and dedups by the pseudonym — the serverless cap. Absent ⇒ Tier-1.
     * Bounded well above the measured BBS proof (~448 chars) + 48-byte G1 pseudonym (64 chars).
     */
    cap: z
      .object({ proof: boundedBase64Url(1024), pseudonym: boundedBase64Url(96) })
      .strict()
      .optional(),
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
  const out: Record<string, CanonicalValue> = {
    schema: a.schema,
    peer_device_id: a.peer_device_id,
    signaling_public_key: a.signaling_public_key,
    transport_hints: [...a.transport_hints],
  };
  // Optional-omit the cap (so a Tier-1 announcement is byte-identical to before).
  if (a.cap !== undefined) out['cap'] = { proof: a.cap.proof, pseudonym: a.cap.pseudonym };
  return out;
}

// NOTE (PRIV-API-RENDEZVOUS-1): the SERVER-side Tier-2 cap — a top-level, verifier-visible BBS proof
// the server/relay checked WITHOUT the rendezvous key — was REMOVED.  Server-side ZK verification
// intrinsically requires the server to hold the per-(room, epoch) issuer key, which is a stable,
// bucket-spanning linking handle that lets an honest-but-curious server re-link a room's
// bucket-rotated blind ids across an entire epoch — breaking §15.3 cross-bucket unlinkability.  There
// is no way to keep server-side dedup AND that unlinkability, so the server reverts to the §27
// Tier-1 sample-poll, and the per-announcer cap is enforced PEER-SIDE only: the cap SEALED INSIDE the
// announcement (`RendezvousAnnouncement.cap`, opened only by a member holding the rendezvous key) is
// verified + deduped by `filterVerifiedPresence` (a member already holds the issuer key, so it leaks
// nothing).  The top-level cap field + its schema are therefore gone.

/** The wire cap for a sealed announcement: a record padded to the §25.4 16 KiB bucket seals to
 *  `AES_GCM_NONCE_LENGTH + PADDING_BUCKET_16K + AES_GCM_TAG_LENGTH` = 16,412 bytes → ⌈·4/3⌉ = 21,883
 *  base64url chars, ABOVE the small-field 16,384 cap.  The announcement's tightened subfield bounds
 *  keep its plaintext inside the 16 KiB bucket, so a valid sealed record never exceeds this — while
 *  the field stays DoS-bounded (the server holds up to MAX_RECORDS_PER_ROOM of these), unlike reusing
 *  the 1.4 MiB inline-op-ciphertext cap (PRIV-RENDEZVOUS-PADCAP). */
export const RENDEZVOUS_SEALED_MAX_CHARS = Math.ceil(
  ((AES_GCM_NONCE_LENGTH + PADDING_BUCKET_16K + AES_GCM_TAG_LENGTH) * 4) / 3,
);

/** §15.3 — the only thing the server stores for an unlisted/detached room: two opaque blind ids,
 *  the sealed announcement, and a short expiry.  The per-announcer cap rides SEALED inside the
 *  announcement (member-only) — the server never sees a cap and runs the §27 Tier-1 sample-poll. */
export const blindRendezvousRecordSchema = z
  .object({
    room_blind_id: base64UrlSchema,
    peer_blind_id: base64UrlSchema,
    encrypted_announcement: boundedBase64Url(RENDEZVOUS_SEALED_MAX_CHARS),
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
 * Build a `BlindRendezvousRecord` for the current `(epoch, time_bucket)`: derive the room + peer
 * blind ids, seal the announcement under the announce key (AAD-bound to the record), and set a
 * clamped short TTL.  The `peer_blind_id` is the deterministic per-`(device, epoch, bucket)` derived
 * id used to ADDRESS §15.4 signaling — but it is NOT an unforgeable storage slot: any member can
 * derive another device's id from the room key, so the server stores presence keyed by the SEALED
 * ANNOUNCEMENT CONTENT (PRIV-API-RENDEZVOUS-4) — a distinct (spoof or re-announced) announcement
 * coexists rather than overwriting another peer's, an identical re-announce is idempotent, and the
 * per-announcer cap rides SEALED inside the announcement for peer-side verification
 * (PRIV-API-RENDEZVOUS-1: no top-level cap; the server runs the §27 Tier-1 sample-poll over all of
 * a room's live records, and the §15.5 membership handshake filters spoofs).
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
  // §15.3.2/§25.4 LENGTH-HIDING (PRIV-RENDEZVOUS-PAD): pad the announcement to a fixed §25.4 bucket
  // BEFORE sealing, so every real record's `encrypted_announcement` is a CONSTANT length regardless of
  // the device id / number of transport hints / presence of the Tier-2 cap.  Without this the sealed
  // length tracked the content, letting an honest-but-curious server (a) distinguish real records from
  // the fixed-length §15.3.2 cover records (defeating the size-inference mitigation) and (b) read a
  // per-device metadata bit (has-hints / has-cap).  A realistic announcement is well under 4 KiB → the
  // 4 KiB bucket (which `buildCoverRecord` matches); a rare oversized one uses a larger bucket (a
  // documented honest residual).
  const plaintext = canonical(serializeAnnouncement(announcement));
  const sealed = await aeadSeal(
    announceKey,
    padBody(plaintext, selectPaddingPolicy(plaintext.length)),
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
  const padded = await aeadOpen(
    announceKey,
    fromBase64Url(record.encrypted_announcement),
    announcementAad(record.room_blind_id, record.peer_blind_id, record.expires_at),
  );
  // Reverse the §25.4 padding applied in `buildRendezvousRecord` (the length prefix is INSIDE the
  // AEAD, so unpadding is exact) before decoding the canonical announcement.
  return rendezvousAnnouncementSchema.parse(decodeCanonical(unpadBody(padded)));
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

export interface BuildCoverRecordParams {
  /** The room's per-epoch §10.2 rendezvous key — so the cover lands under the room's REAL blind id. */
  readonly rendezvousKey: Uint8Array;
  readonly epoch: number;
  readonly timeBucket: number;
  readonly nowMs: number;
  readonly ttlMs?: number;
}

/** The sealed length of a real 4 KiB-bucket-padded announcement: nonce ‖ padded ciphertext ‖ tag.
 *  A cover's `encrypted_announcement` is random bytes of EXACTLY this length so it is byte-length
 *  indistinguishable from a genuine (padded) record (PRIV-RENDEZVOUS-PAD). */
const COVER_SEALED_BYTES = AES_GCM_NONCE_LENGTH + PADDING_BUCKET_4K + AES_GCM_TAG_LENGTH;

/**
 * A §15.3.2 cover record: it lands under the room's REAL `room_blind_id` (derived from the rendezvous
 * key — PRIV-RENDEZVOUS-COVER), with a random `peer_blind_id` (a phantom device) and random-looking
 * sealed bytes of the SAME length a real padded announcement produces, so a server grouping by
 * `room_blind_id` cannot tell it from a genuine online device — the decoys inflate the SPECIFIC
 * per-room concurrent-size count §15.3.2 targets (a random-room cover, by contrast, would form a
 * useless phantom room and leave the real room's count untouched).  It opens for NO member (the bytes
 * are random, not a real seal — `openRendezvousAnnouncement` fails closed), and carries a real TTL.
 */
export async function buildCoverRecord(
  params: BuildCoverRecordParams,
): Promise<BlindRendezvousRecord> {
  const roomBlindId = await deriveRoomBlindId(
    params.rendezvousKey,
    params.epoch,
    params.timeBucket,
  );
  const expiresAt = params.nowMs + clampRendezvousTtl(params.ttlMs ?? RENDEZVOUS_MAX_TTL_MS);
  return blindRendezvousRecordSchema.parse({
    room_blind_id: roomBlindId,
    peer_blind_id: toBase64Url(randomBytes(32)),
    encrypted_announcement: toBase64Url(randomBytes(COVER_SEALED_BYTES)),
    expires_at: expiresAt,
  });
}
