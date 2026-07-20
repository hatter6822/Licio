// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.2.3 — shared scalar building blocks for the private-room schemas
// (PRIVATE_SPEC §10, §11, §13).  Binary values are carried as base64url strings
// (URL-safe — invite secrets ride a URL fragment, §10.3) and content-addressed
// blocks as CIDv1 base32 multibase strings (§9.4); the crypto/IPLD layers
// (WS-S.3/WS-S.4) decode them to bytes.  These schemas are "the single
// normative source"; the TypeScript sketches in PRIVATE_SPEC are illustrative.
import { z } from 'zod';

/** A room-local identifier (room/op/member/device/story/thread/contribution id).
 *  Never a server uuid — private ids are room-scoped strings (§11.1). */
export const privateIdSchema = z.string().min(1).max(128);

/** A CIDv1 base32 multibase string over CIPHERTEXT (§9.4): the pinned
 *  `licio-private-cid-v1` profile — `b` (base32 multibase) + a CIDv1 whose
 *  only codecs are raw `0x55` (→ `bafkrei…`) or dag-cbor `0x71` (→ `bafyrei…`),
 *  SHA-256 (32-byte) digest, so the encoding is a fixed 59 chars.  Pinning the
 *  shape here quarantines a malformed/mis-profiled "CID" at schema intake
 *  rather than letting any 8–256-char base32 string masquerade as one. */
export const privateCidSchema = z
  .string()
  .length(59)
  .regex(
    /^baf[ky]rei[a-z2-7]{52}$/,
    'expected a licio-private-cid-v1 CIDv1 base32 string (b + 58 base32 chars, codec raw 0x55 -> bafkrei / dag-cbor 0x71 -> bafyrei)',
  );

/** A base64url-encoded binary value (no padding): keys, nonces, signatures,
 *  commitments, wrapped keys, ciphertext.  The crypto layer (WS-S.3) decodes. */
export const base64UrlSchema = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+$/, 'expected base64url (no padding)');

/** A base64url-encoded INLINE ciphertext: an op / manifest / snapshot body,
 *  PADDED to a size bucket (§25.4) then AEAD-sealed.  A padded body base64-
 *  expands well past the small-field limit (a `small-op-16k` body ≈ 22 K chars),
 *  so this carries a much larger bound than `base64UrlSchema` — but it is still
 *  BOUNDED for DoS (§27): ~1 MiB of bytes base64url-expanded, ample for any op
 *  body + custom padding, while media uses chunked CIDs (never an inline body). */
export const ciphertextBase64Schema = z
  .string()
  .min(1)
  .max(1_398_102)
  .regex(/^[A-Za-z0-9_-]+$/, 'expected base64url (no padding)');

/** A Lamport timestamp: a non-negative integer serialized as a DECIMAL STRING
 *  (exact beyond 2^53, §14.3.1).  No leading zeros (`0` is allowed alone).  The
 *  40-digit cap (10^40 ops — astronomically beyond any room's op count) bounds
 *  the big-integer comparator (§14.3.1) against a giant-string DoS. */
export const lamportSchema = z
  .string()
  .max(40)
  .regex(/^(0|[1-9]\d*)$/, 'lamport must be a canonical non-negative decimal string');

/** A COARSE time bucket (never an exact timestamp where avoidable, §5.4).
 *  Kept permissive because the archive label field (`snapshot-serve`, etc.)
 *  still needs a free-form coarse tag — use `hourBucketSchema` for any field
 *  that is ALWAYS a UTC hour bucket so a finer-grained value cannot leak. */
export const timeBucketSchema = z.string().min(1).max(64);

/** A COARSE UTC hour bucket, `YYYY-MM-DDTHH` (§5.4).  The always-hour-bucket
 *  envelope/op/invite fields pin this so a full-precision timestamp cannot
 *  masquerade as a "coarse bucket" in server/platform-visible metadata. */
export const hourBucketSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/, 'expected a coarse UTC hour bucket (YYYY-MM-DDTHH), §5.4');

/** §11.3 — room capabilities (NOT platform roles; authority is room-key-only). */
export const PRIVATE_CAPABILITIES = [
  'read',
  'post',
  'invite',
  'moderate',
  'summarize',
  'admin',
  'rotate_keys',
  'recover',
] as const;
export type PrivateCapability = (typeof PRIVATE_CAPABILITIES)[number];
export const privateCapabilitySchema = z.enum(PRIVATE_CAPABILITIES);

/** §11.3 / §12 — suggested member roles (room-local, never a platform role). */
export const PRIVATE_ROLES = ['member', 'moderator', 'admin', 'recovery_admin'] as const;
export type PrivateRole = (typeof PRIVATE_ROLES)[number];
export const privateRoleSchema = z.enum(PRIVATE_ROLES);

/** §10.4 — the AEAD algorithm an envelope's body/key-wrap uses. */
export const PRIVATE_AEAD_ALGORITHMS = ['AES-256-GCM', 'XCHACHA20-POLY1305'] as const;
export type PrivateAeadAlgorithm = (typeof PRIVATE_AEAD_ALGORITHMS)[number];
export const privateAeadAlgorithmSchema = z.enum(PRIVATE_AEAD_ALGORITHMS);

/** §10.4 — the object_type discriminator carried (authenticated) on an envelope. */
export const PRIVATE_OBJECT_TYPES = [
  'room_manifest',
  'membership_op',
  'story_op',
  'thread_op',
  'contribution_op',
  'attachment_manifest',
  'media_chunk',
  'snapshot',
  'local_index_shard',
] as const;
export type PrivateObjectType = (typeof PRIVATE_OBJECT_TYPES)[number];
export const privateObjectTypeSchema = z.enum(PRIVATE_OBJECT_TYPES);

/** §10.4 — the envelope padding policy (op bodies are padded, never compressed). */
export const PRIVATE_PADDING_POLICIES = ['none', 'small-op-4k', 'small-op-16k', 'custom'] as const;
export type PrivatePaddingPolicy = (typeof PRIVATE_PADDING_POLICIES)[number];
export const privatePaddingPolicySchema = z.enum(PRIVATE_PADDING_POLICIES);
