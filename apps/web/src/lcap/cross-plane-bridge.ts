// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.16.1 — the cross-plane bundle bridge (OFFLINE_SPEC §28 / PRIVATE_SPEC §10).
// This is the apps/web glue that lets a WS-S PRIVATE-room ciphertext travel inside a
// WS-R LCAP `.licio-bundle` and be re-imported, WITHOUT the LCAP layer ever decrypting
// it.  The two decentralization planes pin DIFFERENT crypto suites on purpose
// (Ed25519/MLS/HPKE in `@licio/private-p2p`; ES256 in `@licio/lcap`) and never share
// keys or code; here LCAP merely CARRIES opaque ciphertext.
//
// Doctrine enforced, structurally:
//
//   * LCAP NEVER reads private plaintext.  Each private-p2p `PrivateEncryptedEnvelope`
//     is canonical-encoded to opaque bytes, then wrapped as an LCAP `encrypted_payload`
//     block whose CID is computed over the CIPHERTEXT bytes (§28.1: a plaintext CID for
//     private content can never exist).  `buildEncryptedPayloadBlock` hashes the bytes
//     as opaque input; `verifyEncryptedPayloadBlock` re-hashes — it never decrypts.
//   * The carrier descriptor holds ONLY opaque hints.  For the group-keyed (MLS-derived)
//     suite that private rooms use, the §28.2 schema FORBIDS a plaintext digest / exact
//     plaintext size (the §10.6 plaintext-equality leak), so the bridge never supplies
//     one.  The `key_epoch_id` is a hint STRING (the envelope's already-public
//     `room_epoch`), the nonce is opaque bytes, and `aad_context` is the envelope's
//     `aad_hash` COMMITMENT — never the raw AAD inputs.
//   * The bundle/container confers NO trust (§8.3).  Import re-hashes every block
//     (CID/structure only) and re-parses each recovered ciphertext through the
//     private-p2p envelope SCHEMA (fail-closed on a malformed one), then HANDS the
//     opaque envelopes to the caller so the private-p2p engine performs the REAL trust
//     projection (signature + AEAD).  The bridge itself decrypts nothing — a
//     stale-epoch envelope round-trips opaquely and is quarantined LATER by the engine.
//
// `@licio/lcap` and `@licio/private-p2p` are referenced by `import type` only (erased at
// build); every runtime value comes from a DYNAMIC `import()` so the protocol/crypto
// cores stay off the initial bundle (check:lcap-p2p-split / check:private-p2p-split).

import type {
  BlockDescriptorV2,
  EncryptedPayloadDescriptorV2,
  PackHeaderV2,
  PackObject,
  ReaderCaps,
} from '@licio/lcap';
import type { PrivateEncryptedEnvelope } from '@licio/private-p2p';

/** The pack lane an opaque private ciphertext block rides (encrypted media/body, B4). */
const ENCRYPTED_PAYLOAD_LANE = 'B4' as const;
/** The pack priority for opaque encrypted payload (lowest organic, deferred to last). */
const ENCRYPTED_PAYLOAD_PRIORITY = 4 as const;

/** Options for {@link exportPrivateEnvelopesToBundle}. */
export interface ExportPrivateEnvelopesOptions {
  /**
   * The LCAP pack transport profile.  Defaults to `manual_bundle` (a user-saved
   * `.licio-bundle`); a courier/relay caller may override it.
   */
  readonly transportProfile?: PackHeaderV2['transport_profile'];
  /**
   * Override the pack's `max_uncompressed_bytes` budget.  Defaults to the summed
   * ciphertext size plus a small structural headroom.
   */
  readonly maxUncompressedBytes?: number;
}

/** The result of carrying one private envelope as an LCAP encrypted-payload block. */
export interface CarriedEnvelope {
  /** The opaque, canonical-encoded ciphertext bytes (the envelope serialized). */
  readonly ciphertextBytes: Uint8Array;
  /** The `encrypted_payload` block descriptor over those bytes. */
  readonly block: BlockDescriptorV2;
  /** The §28.2 descriptor referencing that block by CID. */
  readonly descriptor: EncryptedPayloadDescriptorV2;
}

/**
 * Derive the OPAQUE LCAP carrier hints from a private envelope's ALREADY-PUBLIC fields.
 * Nothing here reveals plaintext: `room_epoch` is a public counter, `aead.nonce` is the
 * public AEAD nonce, and `aead.aad_hash` is a hash COMMITMENT (never the AAD inputs).
 * The group-keyed (`MLS-derived-AEAD`) suite label means the §28.2 schema rejects any
 * plaintext hint, so we never supply one (§10.6).
 *
 * `@licio/private-p2p`'s `fromBase64Url` is loaded by dynamic import (the codec lives in
 * the lazy private chunk).
 */
async function hintsFromEnvelope(envelope: PrivateEncryptedEnvelope): Promise<{
  readonly suite: 'MLS-derived-AEAD';
  readonly keyEpochId: string;
  readonly nonce: Uint8Array;
  readonly aadContext: Uint8Array;
}> {
  const { fromBase64Url } = await import('@licio/private-p2p');
  // The private room's content is group-keyed (MLS exporter → AEAD); label it as such
  // so the §28.2 schema STRUCTURALLY forbids carrying a plaintext digest / size.
  return {
    suite: 'MLS-derived-AEAD',
    // A hint STRING identifying the key epoch — never a key.  The epoch is a public,
    // monotonically-bumped counter already present in the (signed) envelope metadata.
    keyEpochId: `epoch:${envelope.room_epoch}`,
    // Opaque AEAD nonce bytes (never interpreted by LCAP).
    nonce: fromBase64Url(envelope.aead.nonce),
    // The envelope's `aad_hash` is exactly the §28.2 "opaque commitment to the AAD
    // inputs" — a fixed-size hash, never the raw room id / op-head / sender context.
    aadContext: fromBase64Url(envelope.aead.aad_hash),
  };
}

/**
 * Serialize each private-p2p `PrivateEncryptedEnvelope` to its canonical (DAG-CBOR)
 * bytes, wrap each as an LCAP `encrypted_payload` block carrying ONLY opaque hints, and
 * assemble them into a single `.licio-bundle` byte array (the WS-R.4.1 pack writer).
 *
 * The returned `bundleBytes` are a fully-formed LCAP pack.  The LCAP layer treats the
 * private ciphertext as opaque payload — it never decodes the envelope — so the bundle
 * is safely transportable over any LCAP carrier (courier/relay/manual file) without
 * leaking plaintext.  `carried` exposes the per-envelope ciphertext + descriptors for a
 * caller that wants to verify or index the carriage.
 */
export async function exportPrivateEnvelopesToBundle(
  envelopes: readonly PrivateEncryptedEnvelope[],
  options: ExportPrivateEnvelopesOptions = {},
): Promise<{ readonly bundleBytes: Uint8Array; readonly carried: readonly CarriedEnvelope[] }> {
  const lcap = await import('@licio/lcap');
  const p2p = await import('@licio/private-p2p');

  const carried: CarriedEnvelope[] = [];
  const objects: PackObject[] = [];
  let totalCiphertextBytes = 0;

  for (const envelope of envelopes) {
    // 1) The envelope is a closed, NFC-safe, string-keyed object → canonical DAG-CBOR.
    //    `canonical(...)` is the ONE deterministic profile the private plane signs/CIDs
    //    over, so re-import reproduces byte-identical bytes.  We pass it as an opaque
    //    `CanonicalValue`; LCAP never sees the decoded shape.
    const ciphertextBytes = p2p.canonical(envelope as Parameters<typeof p2p.canonical>[0]);
    totalCiphertextBytes += ciphertextBytes.length;

    // 2) Wrap as an LCAP encrypted_payload block + §28.2 descriptor (opaque hints only).
    //    `buildEncryptedPayloadBlock` hashes the bytes as opaque input — never decrypts.
    const hints = await hintsFromEnvelope(envelope);
    const { block, descriptor } = await lcap.buildEncryptedPayloadBlock(ciphertextBytes, hints);
    carried.push({ ciphertextBytes, block, descriptor });

    // 3) The pack object: a `block` frame keyed by the ciphertext CID, flagged
    //    encrypted/private so a downstream peer routes it as opaque private content.
    objects.push({
      cid: block.block_cid,
      cidKind: 'block',
      frameKind: 'block',
      payload: ciphertextBytes,
      lane: ENCRYPTED_PAYLOAD_LANE,
      priority: ENCRYPTED_PAYLOAD_PRIORITY,
      flags: { encrypted: true, private_metadata: true },
    });
  }

  const bundleBytes = lcap.writePack({
    objects,
    transportProfile: options.transportProfile ?? 'manual_bundle',
    // The pack carries private ciphertext: the most conservative §28.2 privacy label.
    privacyLabel: 'contains_private_encrypted',
    maxUncompressedBytes:
      options.maxUncompressedBytes ?? totalCiphertextBytes + objects.length * 1024 + 1024,
  });

  return { bundleBytes, carried };
}

/** Why a single block could not be recovered as a private envelope (fail-closed). */
export type CrossPlaneImportRejection =
  | 'block_missing' // a table entry references a block with no frame (caught by the reader, defensive)
  | 'cid_unverified' // the frame payload's CID did not match its declared CID
  | 'block_verify_failed' // verifyEncryptedPayloadBlock rejected (wrong role / CID mismatch / structure)
  | 'malformed_envelope'; // the recovered ciphertext did not parse as a PrivateEncryptedEnvelope

/** One recovered private envelope, with the carrier descriptors that delivered it. */
export interface RecoveredEnvelope {
  readonly envelope: PrivateEncryptedEnvelope;
  readonly block: BlockDescriptorV2;
  readonly descriptor: EncryptedPayloadDescriptorV2;
}

/** A rejected block — named so a caller can surface a precise §16.11-style status. */
export interface RejectedBlock {
  readonly cid: string;
  readonly reason: CrossPlaneImportRejection;
}

export interface CrossPlaneImportResult {
  /** The opaque envelopes recovered intact — hand these to the private-p2p engine. */
  readonly envelopes: readonly RecoveredEnvelope[];
  /** Blocks the bundle carried as encrypted_payload that could NOT be recovered. */
  readonly rejected: readonly RejectedBlock[];
}

/** A bundle that failed to PARSE at the LCAP layer (not a per-block rejection). */
export class CrossPlaneBundleError extends Error {
  override readonly name = 'CrossPlaneBundleError';
  constructor(readonly status: string) {
    super(`cross-plane bundle could not be read: ${status}`);
  }
}

/**
 * Read an LCAP `.licio-bundle`, extract every `encrypted_payload` block, verify each
 * WITHOUT decrypting (CID + structure only, the §18.4 no-transport-trust re-hash),
 * recover the raw ciphertext bytes, and re-parse each through the private-p2p envelope
 * SCHEMA so a malformed one fails closed.  Returns the recovered opaque envelopes for
 * the caller to hand to the private-p2p engine's `ingest` / archive-import, which
 * performs the REAL trust projection (signature + AEAD).
 *
 * §8.3 — the bundle confers NO trust: nothing here is decrypted, and a stale-epoch (or
 * forged) envelope round-trips opaquely and is quarantined LATER by the engine.  The
 * pack is read under the §27.1 resource caps; a structural parse failure throws a
 * {@link CrossPlaneBundleError}, while a per-block failure is collected in `rejected`.
 */
export async function importBundleToPrivateEnvelopes(
  bundleBytes: Uint8Array,
  caps?: ReaderCaps,
): Promise<CrossPlaneImportResult> {
  const lcap = await import('@licio/lcap');
  const p2p = await import('@licio/private-p2p');
  const { privateEncryptedEnvelopeSchema } = p2p;

  const read = await lcap.readPack(bundleBytes, caps ?? lcap.DEFAULT_READER_CAPS);
  if (!read.ok) throw new CrossPlaneBundleError(read.status);

  const envelopes: RecoveredEnvelope[] = [];
  const rejected: RejectedBlock[] = [];

  // The table-before-frames layout: walk the table so we process only the entries the
  // pack ADVERTISES (the reader already proved a strict 1:1 table↔frame correspondence,
  // so an unadvertised hidden frame cannot exist).  We carry only `block`-kind entries.
  for (const entry of read.pack.entries) {
    if (entry.cid_kind !== 'block') continue;
    const frame = read.pack.frames.get(entry.cid);
    if (!frame) {
      rejected.push({ cid: entry.cid, reason: 'block_missing' });
      continue;
    }
    if (!frame.cidVerified) {
      // A tampered payload whose CID no longer matches — fail closed before any parse.
      rejected.push({ cid: entry.cid, reason: 'cid_unverified' });
      continue;
    }
    const ciphertextBytes = frame.payload;

    // Reconstruct the block descriptor over the recovered bytes and verify the
    // encrypted-payload carrier (CID/role/structure — NEVER decrypt).  A descriptor is
    // self-describing: it references its own block CID, which IS the frame CID.
    const block = await lcap.buildEncryptedPayloadBlock(ciphertextBytes, {
      suite: 'MLS-derived-AEAD',
      // These hints are not consumed by the verify path (it re-hashes the bytes); they
      // are placeholders that satisfy the §28.2 schema (group-keyed → no plaintext hint).
      keyEpochId: 'epoch:verify',
      nonce: Uint8Array.of(0),
      aadContext: Uint8Array.of(0),
    });
    const verification = await lcap.verifyEncryptedPayloadBlock(
      block.descriptor,
      block.block,
      ciphertextBytes,
    );
    if (!verification.ok) {
      rejected.push({ cid: entry.cid, reason: 'block_verify_failed' });
      continue;
    }

    // Recover the private envelope by decoding the canonical bytes and re-validating
    // through the STRICT schema.  A malformed / non-canonical body fails closed here;
    // a well-formed but stale/forged one passes (opaque) and the engine quarantines it.
    let envelope: PrivateEncryptedEnvelope;
    try {
      const decoded: unknown = p2p.decodeCanonical(ciphertextBytes);
      envelope = privateEncryptedEnvelopeSchema.parse(decoded);
    } catch {
      rejected.push({ cid: entry.cid, reason: 'malformed_envelope' });
      continue;
    }

    envelopes.push({ envelope, block: block.block, descriptor: block.descriptor });
  }

  return { envelopes, rejected };
}
