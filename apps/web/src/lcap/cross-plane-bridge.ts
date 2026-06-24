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
//   * The §28.2 descriptor RIDES THE BUNDLE.  Each ciphertext block is paired with its
//     descriptor, canonical-encoded to its own LCAP block frame and bound to the
//     ciphertext by `descriptor.ciphertext_block_cid` + a `deps` edge.  On import the
//     bridge DECODES the carried descriptor through the strict §28.2 schema and verifies
//     it against the recovered block, so a block that passed the reader's generic CID
//     check but is NOT a valid encrypted_payload carrier (wrong role, a malformed hint,
//     a §10.6-forbidden plaintext hint on the group-keyed suite, or a descriptor whose
//     `ciphertext_block_cid` does not bind the recovered block) is REJECTED — the verify
//     is no longer a self-referential tautology over locally-fabricated placeholders.
//   * Privacy-label routing is FAIL-CLOSED.  The bridge accepts encrypted_payload blocks
//     ONLY from a bundle whose pack `privacy_label` is `contains_private_encrypted`; any
//     other label throws before a single block is parsed (a public bundle never gets
//     mis-extracted as private envelopes).  Symmetrically, the public LCAP import path
//     (`bundle-import.ts`) REFUSES a `contains_private_encrypted` bundle, so private
//     ciphertext never lands in the public `lcap_v2` availability store.
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
/**
 * The pack privacy label that a private-encrypted bundle MUST carry.  The public import
 * path refuses it and the bridge import requires it — the fail-closed routing boundary.
 */
const PRIVATE_PRIVACY_LABEL: PackHeaderV2['privacy_label'] = 'contains_private_encrypted';

/** Options for {@link exportPrivateEnvelopesToBundle}. */
export interface ExportPrivateEnvelopesOptions {
  /**
   * The LCAP pack transport profile.  Defaults to `manual_bundle` (a user-saved
   * `.licio-bundle`); a courier/relay caller may override it.
   */
  readonly transportProfile?: PackHeaderV2['transport_profile'];
  /**
   * Override the pack's `max_uncompressed_bytes` budget.  Defaults to the summed
   * ciphertext + descriptor size plus a small structural headroom.
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
  /** The CID of the descriptor's OWN carrier block (the frame the descriptor rides). */
  readonly descriptorBlockCid: string;
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
    keyEpochId: keyEpochIdFor(envelope.room_epoch),
    // Opaque AEAD nonce bytes (never interpreted by LCAP).
    nonce: fromBase64Url(envelope.aead.nonce),
    // The envelope's `aad_hash` is exactly the §28.2 "opaque commitment to the AAD
    // inputs" — a fixed-size hash, never the raw room id / op-head / sender context.
    aadContext: fromBase64Url(envelope.aead.aad_hash),
  };
}

/** The §28.2 `key_epoch_id` hint string for a public room-epoch counter. */
function keyEpochIdFor(roomEpoch: number): string {
  return `epoch:${roomEpoch}`;
}

/**
 * Serialize each private-p2p `PrivateEncryptedEnvelope` to its canonical (DAG-CBOR)
 * bytes, wrap each as an LCAP `encrypted_payload` block carrying ONLY opaque hints, pair
 * each with its §28.2 descriptor (also CID-addressed, riding its own block frame), and
 * assemble them into a single `.licio-bundle` byte array (the WS-R.4.1 pack writer).
 *
 * The returned `bundleBytes` are a fully-formed LCAP pack labelled
 * `contains_private_encrypted`.  The LCAP layer treats the private ciphertext as opaque
 * payload — it never decodes the envelope — so the bundle is safely transportable over
 * any LCAP carrier (courier/relay/manual file) without leaking plaintext.  `carried`
 * exposes the per-envelope ciphertext + descriptors for a caller that wants to verify or
 * index the carriage.
 */
export async function exportPrivateEnvelopesToBundle(
  envelopes: readonly PrivateEncryptedEnvelope[],
  options: ExportPrivateEnvelopesOptions = {},
): Promise<{ readonly bundleBytes: Uint8Array; readonly carried: readonly CarriedEnvelope[] }> {
  const lcap = await import('@licio/lcap');
  const p2p = await import('@licio/private-p2p');

  const carried: CarriedEnvelope[] = [];
  const objects: PackObject[] = [];
  let totalBytes = 0;

  for (const envelope of envelopes) {
    // 1) The envelope is a closed, NFC-safe, string-keyed object → canonical DAG-CBOR.
    //    `canonical(...)` is the ONE deterministic profile the private plane signs/CIDs
    //    over, so re-import reproduces byte-identical bytes.  We pass it as an opaque
    //    `CanonicalValue`; LCAP never sees the decoded shape.
    const ciphertextBytes = p2p.canonical(envelope as Parameters<typeof p2p.canonical>[0]);
    totalBytes += ciphertextBytes.length;

    // 2) Wrap as an LCAP encrypted_payload block + §28.2 descriptor (opaque hints only).
    //    `buildEncryptedPayloadBlock` hashes the bytes as opaque input — never decrypts.
    const hints = await hintsFromEnvelope(envelope);
    const { block, descriptor } = await lcap.buildEncryptedPayloadBlock(ciphertextBytes, hints);

    // 3) Canonical-encode the descriptor itself and CARRY it in a dedicated block frame
    //    (CID over the descriptor bytes).  Binding it into the bundle (rather than
    //    rebuilding it from placeholders on import) is what makes the import verification
    //    meaningful: the recovered descriptor's `ciphertext_block_cid` + hints are the
    //    EXPORTER's, so a tampered/mismatched descriptor is detectable.
    const descriptorBytes = lcap.encodeWithSchema(
      lcap.encryptedPayloadDescriptorV2Schema,
      descriptor,
    );
    const descriptorBlockCid = await lcap.cidFor('block', descriptorBytes);
    totalBytes += descriptorBytes.length;

    carried.push({ ciphertextBytes, block, descriptor, descriptorBlockCid });

    // 4a) The ciphertext object: a `block` frame keyed by the ciphertext CID, flagged
    //     encrypted/private so a downstream peer routes it as opaque private content.
    objects.push({
      cid: block.block_cid,
      cidKind: 'block',
      frameKind: 'block',
      payload: ciphertextBytes,
      lane: ENCRYPTED_PAYLOAD_LANE,
      priority: ENCRYPTED_PAYLOAD_PRIORITY,
      flags: { encrypted: true, private_metadata: true },
    });
    // 4b) The descriptor object: a sibling `block` frame flagged private_metadata (NOT
    //     `encrypted` — it is the opaque hint metadata, not ciphertext) and bound to the
    //     ciphertext block by a `deps` edge so the importer pairs them deterministically.
    objects.push({
      cid: descriptorBlockCid,
      cidKind: 'block',
      frameKind: 'block',
      payload: descriptorBytes,
      lane: ENCRYPTED_PAYLOAD_LANE,
      priority: ENCRYPTED_PAYLOAD_PRIORITY,
      deps: [block.block_cid],
      flags: { private_metadata: true },
    });
  }

  const bundleBytes = lcap.writePack({
    objects,
    transportProfile: options.transportProfile ?? 'manual_bundle',
    // The pack carries private ciphertext: the most conservative §28.2 privacy label.
    // The bridge import REQUIRES exactly this label; the public import REFUSES it.
    privacyLabel: PRIVATE_PRIVACY_LABEL,
    maxUncompressedBytes: options.maxUncompressedBytes ?? totalBytes + objects.length * 1024 + 1024,
  });

  return { bundleBytes, carried };
}

/** Why a single block could not be recovered as a private envelope (fail-closed). */
export type CrossPlaneImportRejection =
  | 'block_missing' // a table entry references a block with no frame (caught by the reader, defensive)
  | 'cid_unverified' // the frame payload's CID did not match its declared CID
  | 'descriptor_missing' // the ciphertext block carries no §28.2 descriptor frame
  | 'descriptor_malformed' // the carried descriptor did not parse through the strict §28.2 schema
  | 'block_verify_failed' // verifyEncryptedPayloadBlock rejected (wrong role / CID mismatch / structure)
  | 'epoch_hint_mismatch' // the descriptor's key_epoch_id disagrees with the envelope's room_epoch
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

/** A bundle that failed to PARSE at the LCAP layer, or that is not a private bundle. */
export class CrossPlaneBundleError extends Error {
  override readonly name = 'CrossPlaneBundleError';
  constructor(readonly status: string) {
    super(`cross-plane bundle could not be read: ${status}`);
  }
}

/** True iff the pack header marks the bundle as carrying private encrypted content. */
function isPrivateBundleLabel(label: PackHeaderV2['privacy_label']): boolean {
  return label === PRIVATE_PRIVACY_LABEL;
}

/**
 * Read an LCAP `.licio-bundle`, extract every `encrypted_payload` block, verify each
 * against the EXPORTER'S carried §28.2 descriptor WITHOUT decrypting (CID + role +
 * structure + descriptor schema, the §18.4 no-transport-trust re-hash), recover the raw
 * ciphertext bytes, and re-parse each through the private-p2p envelope SCHEMA so a
 * malformed one fails closed.  Returns the recovered opaque envelopes for the caller to
 * hand to the private-p2p engine's `ingest` / archive-import, which performs the REAL
 * trust projection (signature + AEAD).
 *
 * Privacy-label routing (fail-closed): the bundle's pack `privacy_label` MUST be
 * `contains_private_encrypted`.  Any other label throws a {@link CrossPlaneBundleError}
 * BEFORE any block is parsed — a public bundle can never be mis-extracted into private
 * envelopes, and only frames explicitly flagged `encrypted` (the ciphertext role) are
 * considered, never every `block`-kind entry.
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

  // Fail-closed privacy-label routing: only a `contains_private_encrypted` bundle may be
  // routed into the private plane.  A public / in-room-metadata bundle is NOT ours — it
  // belongs to the public LCAP import path — so refuse it WHOLESALE before parsing any
  // block, rather than producing a flood of `malformed_envelope` rejections.
  if (!isPrivateBundleLabel(read.pack.header.privacy_label)) {
    throw new CrossPlaneBundleError('not_private_bundle');
  }

  const envelopes: RecoveredEnvelope[] = [];
  const rejected: RejectedBlock[] = [];

  // Index the table by CID so a ciphertext entry can locate its carried descriptor entry
  // (bound by a `deps` edge).  The reader already proved a strict 1:1 table↔frame
  // correspondence, so an entry's CID maps to exactly one frame.
  const entryByCid = new Map(read.pack.entries.map((entry) => [entry.cid, entry]));
  // The descriptor entry that DEPENDS ON a given ciphertext CID (the carrier pairing).
  const descriptorEntryForCiphertext = new Map<string, string>();
  for (const entry of read.pack.entries) {
    for (const dep of entry.deps ?? []) descriptorEntryForCiphertext.set(dep, entry.cid);
  }

  for (const entry of read.pack.entries) {
    if (entry.cid_kind !== 'block') continue;
    // SELECT BY ROLE, not by blanket `block`-kind: an encrypted_payload ciphertext entry
    // is the one flagged `encrypted`.  The descriptor sibling (private_metadata only) and
    // any non-encrypted block are skipped here — a public block can never be mis-parsed
    // as an envelope.
    if (entry.flags?.encrypted !== true) continue;

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

    // Locate + decode the EXPORTER's carried §28.2 descriptor for this ciphertext block.
    const descriptorCid = descriptorEntryForCiphertext.get(entry.cid);
    const descriptorFrame = descriptorCid ? read.pack.frames.get(descriptorCid) : undefined;
    if (descriptorCid === undefined || !descriptorFrame || !entryByCid.has(descriptorCid)) {
      rejected.push({ cid: entry.cid, reason: 'descriptor_missing' });
      continue;
    }
    if (!descriptorFrame.cidVerified) {
      rejected.push({ cid: entry.cid, reason: 'cid_unverified' });
      continue;
    }
    let descriptor: EncryptedPayloadDescriptorV2;
    try {
      // The STRICT §28.2 schema rejects a wrong-version / malformed-hint / unknown-field
      // descriptor AND a group-keyed-suite descriptor carrying a plaintext hint (§10.6).
      descriptor = lcap.decodeWithSchema(
        lcap.encryptedPayloadDescriptorV2Schema,
        descriptorFrame.payload,
      );
    } catch {
      rejected.push({ cid: entry.cid, reason: 'descriptor_malformed' });
      continue;
    }

    // Reconstruct the block descriptor over the recovered bytes (CID/role/sha256/size),
    // then verify the EXPORTER'S descriptor against it.  This is NOW meaningful: the
    // carried `ciphertext_block_cid` must bind THIS recovered block, the role must be
    // `encrypted_payload`, and any plaintext hint must not equal the ciphertext digest —
    // a tampered descriptor (wrong CID binding, smuggled plaintext hint) is rejected.
    const block = await lcap.buildEncryptedPayloadBlock(ciphertextBytes, {
      suite: descriptor.suite,
      keyEpochId: descriptor.key_epoch_id,
      nonce: descriptor.nonce,
      aadContext: descriptor.aad_context,
      ...(descriptor.plaintext_sha256 !== undefined
        ? { plaintextSha256: descriptor.plaintext_sha256 }
        : {}),
      ...(descriptor.plaintext_size !== undefined
        ? { plaintextSize: descriptor.plaintext_size }
        : {}),
    });
    const verification = await lcap.verifyEncryptedPayloadBlock(
      descriptor,
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

    // Bind the OPAQUE epoch hint to the recovered envelope's already-public `room_epoch`.
    // LCAP never trusts the hint — but a hint that DISAGREES with the ciphertext it labels
    // is a sign the descriptor was paired to the wrong block, so reject it rather than let
    // an epoch-bucketed downstream consumer be misled.
    if (descriptor.key_epoch_id !== keyEpochIdFor(envelope.room_epoch)) {
      rejected.push({ cid: entry.cid, reason: 'epoch_hint_mismatch' });
      continue;
    }

    envelopes.push({ envelope, block: block.block, descriptor });
  }

  return { envelopes, rejected };
}
