// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.8 — the `validate(record)` trust-projection pipeline.  The full §18.3
// staged matrix (integrity → proof → authority → consensus), the trust-state
// lub, the staleness distinction, and the no-transport-trust property (the
// state is independent of arrival path; a malformed body never renders trusted).

import { beforeAll, describe, expect, it } from 'vitest';
import { buildCheckpoint, RoomLog, signCheckpoint } from '../checkpoint/index.js';
import { cidFor } from '../cid/index.js';
import { type DeviceKeyPair, exportPublicKeyCose, generateDeviceKey } from '../cose/keys.js';
import { buildAndSign, type DetachedProofV2 } from '../cose/sign1.js';
import {
  type CapabilityBundle,
  type CertificateBundle,
  type IdentityChainDeps,
  issueCapability,
  issueDeviceCertificate,
  RevocationIndex,
} from '../identity/index.js';
import { encodeContributionEvent } from '../records/index.js';
import { inclusionProofRecordV2Schema } from '../schemas/checkpoint.js';
import type { ContributionEventRecordV2 } from '../schemas/records.js';
import { type ValidationInput, validate } from '../validate/index.js';

const NET = 'prod';
const NOW = 1_000_000;

let accountAuthority: DeviceKeyPair;
let roomAuthority: DeviceKeyPair;
let device: DeviceKeyPair;
let certBundle: CertificateBundle;
let capBundle: CapabilityBundle;
let capabilityCid: string;
let contribution: ContributionEventRecordV2;
let body: Uint8Array;
let recordCid: string;
let proof: DetachedProofV2;
let log: RoomLog;
let inclusionProof: ReturnType<typeof inclusionProofRecordV2Schema.parse>;
let checkpoint: Awaited<ReturnType<typeof buildCheckpoint>>;

function deps(revocations = new RevocationIndex()): IdentityChainDeps {
  return {
    resolveCertificate: (k) => (k === 'key-1' ? certBundle : undefined),
    resolveCapability: (c) => (c === capabilityCid ? capBundle : undefined),
    resolveAccountAuthorityKey: (a) => (a === 'acct-1' ? accountAuthority.publicKey : undefined),
    resolveRoomAuthorityKey: (r) => (r === 'room-1' ? roomAuthority.publicKey : undefined),
    revocations,
  };
}

function input(over: Partial<ValidationInput> = {}): ValidationInput {
  return {
    recordCid,
    body,
    proofs: [proof],
    resolveSignerPublicKey: async (id) => (id === 'key-1' ? device.publicKey : undefined),
    identityDeps: deps(),
    ctx: { networkId: NET, nowMs: NOW },
    ...over,
  };
}

beforeAll(async () => {
  accountAuthority = await generateDeviceKey();
  roomAuthority = await generateDeviceKey();
  device = await generateDeviceKey();
  certBundle = await issueDeviceCertificate({
    authorityPrivateKey: accountAuthority.privateKey,
    authoritySignerKeyId: 'account-authority-1',
    certificate: {
      record_version: 2,
      kind: 'device_certificate',
      account_id: 'acct-1',
      device_id: 'dev-1',
      device_key_id: 'key-1',
      public_key_cose: await exportPublicKeyCose(device.publicKey),
      issued_at_ms: NOW - 1000,
      not_before_ms: NOW - 1000,
      not_after_ms: NOW + 1_000_000,
      issuer: 'licio_account_authority',
      account_epoch: 1,
    },
    networkId: NET,
  });
  capBundle = await issueCapability({
    authorityPrivateKey: roomAuthority.privateKey,
    authoritySignerKeyId: 'room-authority-1',
    capability: {
      record_version: 2,
      kind: 'room_capability',
      capability_id: 'cap-1',
      subject_account_id: 'acct-1',
      subject_device_id: 'dev-1',
      subject_device_key_id: 'key-1',
      room_id: 'room-1',
      visibility_scope: 'in_room',
      operations: ['post', 'reply'],
      policy_epoch: 2,
      revocation_epoch_floor: 0,
      not_before_ms: NOW - 1000,
      not_after_ms: NOW + 1_000_000,
      quotas: {
        max_offline_events: 10,
        max_total_payload_bytes: 10000,
        max_single_event_bytes: 1000,
        max_media_bytes: 0,
      },
      transfer_policy: {
        may_export_bundle: true,
        may_share_with_relay: false,
        may_share_with_courier: false,
        may_share_with_unknown_peer: false,
      },
    },
    networkId: NET,
  });
  capabilityCid = await cidFor('record', capBundle.body);
  contribution = {
    record_version: 2,
    kind: 'contribution_event',
    event_type: 'post',
    home_room_id: 'room-1',
    visibility_scope: 'in_room',
    author_account_id: 'acct-1',
    author_device_id: 'dev-1',
    author_device_key_id: 'key-1',
    device_seq: 0,
    capability_cid: capabilityCid,
    policy_epoch_claim: 2,
    revocation_epoch_claim: 0,
    client_nonce: new Uint8Array([1, 2, 3, 4]),
    priority: 1,
  };
  body = encodeContributionEvent(contribution);
  recordCid = await cidFor('record', body);
  proof = await buildAndSign({
    privateKey: device.privateKey,
    signerKeyId: 'key-1',
    proofKind: 'device_signature',
    recordKind: 'contribution_event',
    recordBody: body,
    networkId: NET,
  });
  // A room log containing the contribution, plus a checkpoint + inclusion proof.
  log = new RoomLog('RFC9162_SHA256', NET);
  await log.append(await cidFor('record', new Uint8Array([0])));
  const leafIndex = await log.append(recordCid);
  checkpoint = await buildCheckpoint(log, {
    roomId: 'room-1',
    treeSize: log.size,
    policyEpoch: 2,
    revocationEpoch: 0,
    issuedAtMs: NOW,
    signerAuthorityId: 'auth-1',
  });
  const checkpointBundle = await signCheckpoint({
    authorityPrivateKey: roomAuthority.privateKey,
    authoritySignerKeyId: 'room-authority-1',
    checkpoint,
    networkId: NET,
  });
  inclusionProof = inclusionProofRecordV2Schema.parse({
    record_version: 2,
    kind: 'inclusion_proof',
    room_id: 'room-1',
    checkpoint_cid: await cidFor('record', checkpointBundle.body),
    target_record_cid: recordCid,
    leaf_index: leafIndex,
    tree_size: log.size,
    proof_hashes: await log.inclusionProof(leafIndex),
  });
});

describe('stage 1 — integrity + proof (WS-R.8.2a)', () => {
  it('rejects a bad CID and a bad schema', async () => {
    expect((await validate(input({ recordCid: 'lcapr_wrong' }))).rejection).toBe(
      'rejected_bad_cid',
    );
    const garbage = new Uint8Array([0xa1, 0x61, 0x78, 0x01]); // {"x":1}: valid CBOR, not a record
    const garbageCid = await cidFor('record', garbage);
    expect((await validate(input({ body: garbage, recordCid: garbageCid }))).rejection).toBe(
      'rejected_bad_schema',
    );
  });

  it('quarantines (not rejects) on a missing proof or missing signer key', async () => {
    const noProof = await validate(input({ proofs: [] }));
    expect(noProof.state).toBe('integrity_verified');
    expect(noProof.missingCids.some((c) => c.startsWith('proof_for:'))).toBe(true);

    const noKey = await validate(input({ resolveSignerPublicKey: async () => undefined }));
    expect(noKey.state).toBe('integrity_verified');
    expect(noKey.missingCids.some((c) => c.startsWith('signer_key:'))).toBe(true);
  });

  it('does not let a non-author key authorize a contribution (no device impersonation)', async () => {
    // A proof whose signer_key_id differs from the record's claimed author_device_key_id
    // must NOT mark the record proof-verified — otherwise a registered attacker device
    // could sign a body naming the victim's author key + sequence and have it accepted.
    const impersonating: DetachedProofV2 = { ...proof, signer_key_id: 'attacker-key' };
    const result = await validate(input({ proofs: [impersonating] }));
    expect(result.state).toBe('integrity_verified'); // never proof_verified / authorized
    expect(result.missingCids.some((c) => c.startsWith('proof_for:'))).toBe(true);
  });

  it('rejects a present-but-bad signature (canonical, wrong) and an out-of-range one', async () => {
    // A real low-S signature over different bytes → crypto failure at step 6.
    const wrong = await buildAndSign({
      privateKey: device.privateKey,
      signerKeyId: 'key-1',
      proofKind: 'device_signature',
      recordKind: 'contribution_event',
      recordBody: new Uint8Array([9, 9, 9]),
      networkId: NET,
    });
    const canonicalWrong: DetachedProofV2 = { ...proof, signature: wrong.signature };
    expect((await validate(input({ proofs: [canonicalWrong] }))).rejection).toBe(
      'rejected_bad_signature',
    );
    // An all-zero (out-of-range) signature is rejected at the canonical check.
    const zero: DetachedProofV2 = { ...proof, signature: new Uint8Array(64) };
    expect((await validate(input({ proofs: [zero] }))).rejection).toBe('rejected_high_s_signature');
  });
});

describe('stage 2 — authority chain (WS-R.8.2b)', () => {
  it('rejects an event over the capability single-event quota (rejected_quota)', async () => {
    // The fixture capability caps a single event at 1000 bytes.  validate must thread the
    // signed record's byte size into the chain so the quota is enforced (WS-R.1 §18.3
    // step 9); absent the size the chain would wrongly reach authorized_provisional.
    const oversized: ContributionEventRecordV2 = {
      ...contribution,
      client_nonce: new Uint8Array(2000).fill(7), // pushes the body past max_single_event_bytes
    };
    const oversizedBody = encodeContributionEvent(oversized);
    expect(oversizedBody.length).toBeGreaterThan(1000);
    const oversizedCid = await cidFor('record', oversizedBody);
    const oversizedProof = await buildAndSign({
      privateKey: device.privateKey,
      signerKeyId: 'key-1',
      proofKind: 'device_signature',
      recordKind: 'contribution_event',
      recordBody: oversizedBody,
      networkId: NET,
    });
    const result = await validate(
      input({ body: oversizedBody, recordCid: oversizedCid, proofs: [oversizedProof] }),
    );
    expect(result.rejection).toBe('rejected_quota');
  });

  it('reaches authorized_provisional on a full valid chain', async () => {
    const result = await validate(input());
    expect(result.state).toBe('authorized_provisional');
    expect(result.facts).toMatchObject({
      capabilityId: 'cap-1',
      roomId: 'room-1',
      signerKeyId: 'key-1',
    });
  });

  it('quarantines proof_verified when the capability is missing', async () => {
    const result = await validate(
      input({ identityDeps: { ...deps(), resolveCapability: () => undefined } }),
    );
    expect(result.state).toBe('proof_verified');
    expect(result.missingCids).toContain(capabilityCid);
  });

  it('rejects an operation the capability does not grant', async () => {
    const moderation = { ...contribution, event_type: 'moderation_action' as const };
    const modBody = encodeContributionEvent(moderation);
    const modCid = await cidFor('record', modBody);
    const modProof = await buildAndSign({
      privateKey: device.privateKey,
      signerKeyId: 'key-1',
      proofKind: 'device_signature',
      recordKind: 'contribution_event',
      recordBody: modBody,
      networkId: NET,
    });
    const result = await validate(input({ body: modBody, recordCid: modCid, proofs: [modProof] }));
    expect(result.rejection).toBe('rejected_policy_denied');
  });

  it('revokes a revoked device regardless of an otherwise-valid chain', async () => {
    const revocations = new RevocationIndex();
    revocations.index({
      record_version: 2,
      kind: 'revocation',
      revocation_id: 'r',
      revoked_kind: 'device',
      revoked_id: 'key-1',
      effective_at_ms: NOW,
      revocation_epoch: 3,
    });
    const result = await validate(input({ identityDeps: deps(revocations) }));
    expect(result).toMatchObject({ state: 'revoked', revoked: { kind: 'device', id: 'key-1' } });
  });

  it('distinguishes stale_authorized when the revocation frontier is behind', async () => {
    const staleCap: CapabilityBundle = {
      ...capBundle,
      capability: { ...capBundle.capability, revocation_epoch_floor: 99 },
    };
    const result = await validate(
      input({ identityDeps: { ...deps(), resolveCapability: () => staleCap } }),
    );
    expect(result.state).toBe('stale_authorized');
  });
});

describe('stage 3 — consensus (WS-R.8.2c)', () => {
  it('reaches checkpointed with a valid inclusion proof', async () => {
    const result = await validate(
      input({ consensus: { inclusion: { proof: inclusionProof, checkpoint } } }),
    );
    expect(result.state).toBe('checkpointed');
  });

  it('does not reach checkpointed with an inclusion proof for a DIFFERENT record', async () => {
    // A proof whose target_record_cid is some other record must not raise this record's
    // trust to checkpointed (no inclusion-proof confusion across records).
    const otherTarget = {
      ...inclusionProof,
      target_record_cid: await cidFor('record', new Uint8Array([7, 7, 7])),
    };
    const result = await validate(
      input({ consensus: { inclusion: { proof: otherTarget, checkpoint } } }),
    );
    expect(result.state).toBe('authorized_provisional');
  });

  it('reaches witnessed (the lub over checkpoint + witness)', async () => {
    const result = await validate(
      input({
        consensus: { inclusion: { proof: inclusionProof, checkpoint }, witnessVerified: true },
      }),
    );
    expect(result.state).toBe('witnessed');
  });

  it('reflects server receipts between authorized and checkpointed', async () => {
    expect((await validate(input({ consensus: { serverReceipt: 'stored' } }))).state).toBe(
      'server_stored',
    );
    expect((await validate(input({ consensus: { serverReceipt: 'accepted' } }))).state).toBe(
      'server_accepted',
    );
  });

  it('marks conflicting on a device fork', async () => {
    const result = await validate(input({ consensus: { deviceForkDetected: true } }));
    expect(result).toMatchObject({ state: 'conflicting', conflict: 'device_fork' });
  });
});

describe('no transport trust (WS-R.8.3)', () => {
  it('yields an identical state regardless of arrival path (no source input)', async () => {
    // Two validations of the same record differ only in unrelated context;
    // `validate` has no "source" parameter, so the state must match exactly.
    const fromFriend = await validate(input());
    const fromHostileRelay = await validate(input());
    expect(fromHostileRelay.state).toBe(fromFriend.state);
    expect(fromHostileRelay).toEqual(fromFriend);
  });

  it('never renders a malformed body as trusted', async () => {
    const malformed = new Uint8Array([0xff, 0xff, 0xff]); // non-canonical / undecodable
    const malformedCid = await cidFor('record', malformed);
    const result = await validate(input({ body: malformed, recordCid: malformedCid, proofs: [] }));
    expect(['rejected', 'integrity_verified', 'raw_unverified']).toContain(result.state);
    expect(result.state).not.toBe('authorized_provisional');
  });
});
