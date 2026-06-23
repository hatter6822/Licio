// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.16.1 — the cross-plane bundle bridge (apps/web glue).  Proves a WS-S private
// envelope (opaque ciphertext) round-trips through a WS-R `.licio-bundle` WITHOUT the
// LCAP layer ever decrypting it:
//   (a) the recovered ciphertext is byte-identical;
//   (b) the bundle bytes contain NO plaintext (only ciphertext + opaque hints);
//   (c) a tampered bundle fails closed (the encrypted-payload verify rejects);
//   (d) a stale-epoch (but schema-valid) envelope round-trips OPAQUELY — the bridge
//       never decrypts, so the private engine quarantines it LATER, not here.
//
// `@licio/private-p2p` (REAL MLS/HPKE/Ed25519 crypto) is loaded by dynamic import, the
// same code-split discipline the bridge enforces.

import type { PrivateEncryptedEnvelope, PrivateOpBodyInput } from '@licio/private-p2p';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CrossPlaneBundleError,
  exportPrivateEnvelopesToBundle,
  importBundleToPrivateEnvelopes,
} from '../cross-plane-bridge.js';

const PROFILE = { name: 'Cross-plane bridge', room_type: 'global_topic' } as const;

/**
 * Build two REAL sealed `PrivateEncryptedEnvelope`s via the shipped private-p2p crypto:
 * the founder-genesis member.add op + a story.create op carrying a recognizable title.
 * Returns the envelopes plus the plaintext title token (a string we assert NEVER leaks
 * into the LCAP bundle bytes).
 */
async function sealRealEnvelopes(): Promise<{
  readonly envelopes: readonly PrivateEncryptedEnvelope[];
  readonly plaintextTitle: string;
}> {
  const p2p = await import('@licio/private-p2p');
  const roomId = 'room-cross-plane';
  const plaintextTitle = 'SECRET-TITLE-do-not-leak-42';

  const created = await p2p.createPrivateRoom({
    roomId,
    founderMemberId: 'founder',
    founderDeviceId: 'founder-dev',
    profile: PROFILE,
  });

  // Drive an engine so the story op gets a coherent lamport/seq/parents chain.
  const engine = await p2p.PrivateRoomEngine.load({
    ...created.engineParams,
    storage: new p2p.InMemoryPrivateRoomStorage(),
  });
  await engine.applyLocalOp(created.genesisOp, created.sealParams);

  const storyBody: PrivateOpBodyInput = {
    type: 'story.create',
    story_id: 's1',
    thread_id: 't1',
    title: plaintextTitle,
    submission_type: 'original_brief',
    topic_ids: [],
    submission_metadata: {},
  };
  const { op: storyOp, sealParams: storySeal } = await p2p.buildRoomOp(
    {
      roomId,
      roomIdCommitment: created.roomIdCommitment,
      epochState: created.epochState,
      author: {
        memberId: 'founder',
        deviceId: 'founder-dev',
        signingKey: created.founder.signingKeyPair.privateKey,
        seq: engine.nextAuthorSeq('founder-dev'),
      },
      opId: globalThis.crypto.randomUUID(),
      parents: engine.heads(),
      lamport: engine.nextLamport(),
    },
    storyBody,
  );

  // Seal each op into a signed, AEAD-encrypted envelope (the wire object LCAP carries).
  const genesisEnvelope = await p2p.sealOp(created.genesisOp, created.sealParams);
  const storyEnvelope = await p2p.sealOp(storyOp, storySeal);

  return { envelopes: [genesisEnvelope, storyEnvelope], plaintextTitle };
}

describe('WS-R.16.1 cross-plane bundle bridge', () => {
  let envelopes: readonly PrivateEncryptedEnvelope[];
  let plaintextTitle: string;

  beforeAll(async () => {
    const sealed = await sealRealEnvelopes();
    envelopes = sealed.envelopes;
    plaintextTitle = sealed.plaintextTitle;
  });

  it('(a) round-trips private envelopes byte-identically through a .licio-bundle', async () => {
    const p2p = await import('@licio/private-p2p');
    const { bundleBytes, carried } = await exportPrivateEnvelopesToBundle(envelopes);
    expect(bundleBytes.byteLength).toBeGreaterThan(0);
    expect(carried).toHaveLength(envelopes.length);

    const result = await importBundleToPrivateEnvelopes(bundleBytes);
    expect(result.rejected).toHaveLength(0);
    expect(result.envelopes).toHaveLength(envelopes.length);

    // Each recovered envelope's canonical bytes are byte-identical to the original's,
    // and the recovered logical envelope deep-equals the original (the strict schema
    // accepted it).  Match by the (unique) carried ciphertext CID, order-independent.
    const byCid = new Map(carried.map((c) => [c.block.block_cid, c.ciphertextBytes]));
    for (const recovered of result.envelopes) {
      const originalBytes = byCid.get(recovered.block.block_cid);
      expect(originalBytes).toBeDefined();
      const recoveredBytes = p2p.canonical(
        recovered.envelope as Parameters<typeof p2p.canonical>[0],
      );
      expect(Array.from(recoveredBytes)).toEqual(Array.from(originalBytes as Uint8Array));
    }

    // The set of recovered envelopes equals the input set (matched by canonical bytes).
    const recoveredSet = new Set(
      result.envelopes.map((r) =>
        p2p.toBase64Url(p2p.canonical(r.envelope as Parameters<typeof p2p.canonical>[0])),
      ),
    );
    for (const original of envelopes) {
      expect(
        recoveredSet.has(
          p2p.toBase64Url(p2p.canonical(original as Parameters<typeof p2p.canonical>[0])),
        ),
      ).toBe(true);
    }
  });

  it('(a2) carries only opaque hints — no plaintext digest/size for the group-keyed suite', async () => {
    const { carried } = await exportPrivateEnvelopesToBundle(envelopes);
    for (const c of carried) {
      // The §28.2 descriptor labels the group-keyed suite and FORBIDS plaintext hints.
      expect(c.descriptor.suite).toBe('MLS-derived-AEAD');
      expect(c.descriptor.plaintext_sha256).toBeUndefined();
      expect(c.descriptor.plaintext_size).toBeUndefined();
      // The block plays the encrypted_payload role over the ciphertext CID.
      expect(c.block.role).toBe('encrypted_payload');
      expect(c.descriptor.ciphertext_block_cid).toBe(c.block.block_cid);
    }
  });

  it('(b) the bundle bytes do NOT contain the plaintext (no leakage)', async () => {
    const { bundleBytes } = await exportPrivateEnvelopesToBundle(envelopes);

    // The plaintext title must not appear anywhere in the bundle bytes (UTF-8 search).
    const titleBytes = new TextEncoder().encode(plaintextTitle);
    expect(indexOfBytes(bundleBytes, titleBytes)).toBe(-1);
    // The decoded string form (for paranoia across encodings) is also absent.
    const asLatin1 = Array.from(bundleBytes, (b) => String.fromCharCode(b)).join('');
    expect(asLatin1.includes(plaintextTitle)).toBe(false);
  });

  it('(c) a tampered bundle fails closed (verifyEncryptedPayloadBlock rejects)', async () => {
    const { bundleBytes } = await exportPrivateEnvelopesToBundle(envelopes);

    // Flip a byte deep in the FRAME region (past the magic/header/table) so a frame's
    // payload no longer hashes to its declared CID.  The reader marks `cidVerified`
    // false (or the strict reader rejects); the bridge rejects that block, recovering
    // NO envelope from it — it never decrypts a tampered payload.
    const tampered = bundleBytes.slice();
    const flipAt = tampered.length - 4;
    tampered[flipAt] = (tampered[flipAt] ?? 0) ^ 0xff;

    let rejectedSomething = false;
    try {
      const result = await importBundleToPrivateEnvelopes(tampered);
      // Either a per-block rejection (cid_unverified / verify failure / malformed) ...
      rejectedSomething = result.rejected.length > 0;
      // ... and a tampered envelope must NEVER be returned as recovered intact.
      expect(result.envelopes.length).toBeLessThan(envelopes.length);
    } catch (error) {
      // ... or a whole-bundle structural rejection (the reader's CID-frame check).
      expect(error).toBeInstanceOf(CrossPlaneBundleError);
      rejectedSomething = true;
    }
    expect(rejectedSomething).toBe(true);
  });

  it('(c2) a non-bundle input throws a CrossPlaneBundleError (bad magic)', async () => {
    await expect(
      importBundleToPrivateEnvelopes(new Uint8Array([1, 2, 3, 4])),
    ).rejects.toBeInstanceOf(CrossPlaneBundleError);
  });

  it('(d) a stale-epoch envelope round-trips OPAQUELY — the bridge never decrypts/errors', async () => {
    const p2p = await import('@licio/private-p2p');
    const [genesis] = envelopes;
    expect(genesis).toBeDefined();

    // Construct a STALE-epoch envelope: schema-valid (so it carries opaquely) but bound
    // to a different epoch than the room currently holds.  The bridge does NOT verify
    // signatures or AEAD, so it round-trips this opaquely; a real private engine would
    // quarantine it on ingest (the AEAD wrap is keyed to the wrong epoch).
    const staleEpoch = (genesis as PrivateEncryptedEnvelope).room_epoch + 7;
    const staleEnvelope = p2p.privateEncryptedEnvelopeSchema.parse({
      ...(genesis as PrivateEncryptedEnvelope),
      room_epoch: staleEpoch,
      key_wrap: { ...(genesis as PrivateEncryptedEnvelope).key_wrap, wrapping_epoch: staleEpoch },
    });

    const { bundleBytes, carried } = await exportPrivateEnvelopesToBundle([staleEnvelope]);
    // The opaque hint reflects the (public) stale epoch — never a key.
    expect(carried[0]?.descriptor.key_epoch_id).toBe(`epoch:${staleEpoch}`);

    const result = await importBundleToPrivateEnvelopes(bundleBytes);
    // The bridge returned the envelope WITHOUT decrypting or erroring (§8.3 — no trust).
    expect(result.rejected).toHaveLength(0);
    expect(result.envelopes).toHaveLength(1);
    const recovered = result.envelopes[0]?.envelope;
    expect(recovered?.room_epoch).toBe(staleEpoch);
    // Byte-identical opaque round-trip — the engine, not the bridge, judges trust.
    const original = p2p.canonical(staleEnvelope as Parameters<typeof p2p.canonical>[0]);
    const back = p2p.canonical(recovered as Parameters<typeof p2p.canonical>[0]);
    expect(Array.from(back)).toEqual(Array.from(original));
  });
});

/** Find the first index of `needle` within `haystack` (−1 if absent). */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}
