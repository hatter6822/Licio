// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.1 — identity, certificates, capabilities, revocations, and the §18.3
// steps-6-11 chain validator.  Full-chain accept plus every broken-link case
// (missing / expired / forged / denied / revoked) with the right status and
// missing dependencies.

import { beforeAll, describe, expect, it } from 'vitest';
import { cidFor } from '../cid/index.js';
import { type DeviceKeyPair, exportPublicKeyCose, generateDeviceKey } from '../cose/keys.js';
import { buildAndSign } from '../cose/sign1.js';
import {
  type CapabilityBundle,
  CapabilityUsageTracker,
  type CertificateBundle,
  capabilityAuthorizes,
  DeviceSequenceChain,
  type IdentityChainDeps,
  issueCapability,
  issueDeviceCertificate,
  type RevocationAuthorityBinding,
  RevocationIndex,
  revocationAuthorityScope,
  validateIdentityChain,
  verifyCapability,
  verifyDeviceCertificate,
  verifyExportAuthorization,
  verifyRevocationAuthority,
} from '../identity/index.js';
import { revocationPriority } from '../identity/revocation.js';
import { defaultLane } from '../priority.js';
import { encodeWithSchema } from '../schemas/codec.js';
import { type ExportRequestV2, exportRequestV2Schema } from '../schemas/export-request.js';
import {
  type CapabilityRecordV2,
  type ContributionEventRecordV2,
  type RevocationRecordV2,
  revocationRecordV2Schema,
} from '../schemas/records.js';

const NETWORK = 'test';
const NOW = 1_000_000;

let accountAuthority: DeviceKeyPair;
let roomAuthority: DeviceKeyPair;
let device: DeviceKeyPair;
let certBundle: CertificateBundle;
let capBundle: CapabilityBundle;
let capabilityCid: string;
let contribution: ContributionEventRecordV2;

const quotas: CapabilityRecordV2['quotas'] = {
  max_offline_events: 3,
  max_total_payload_bytes: 1000,
  max_single_event_bytes: 400,
  max_media_bytes: 0,
};

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
    networkId: NETWORK,
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
      operations: ['post', 'reply', 'edit'],
      policy_epoch: 2,
      revocation_epoch_floor: 0,
      not_before_ms: NOW - 1000,
      not_after_ms: NOW + 1_000_000,
      quotas,
      transfer_policy: {
        may_export_bundle: true,
        may_share_with_relay: false,
        may_share_with_courier: false,
        may_share_with_unknown_peer: false,
      },
    },
    networkId: NETWORK,
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
});

function makeDeps(revocations = new RevocationIndex()): IdentityChainDeps {
  return {
    resolveCertificate: (k) => (k === 'key-1' ? certBundle : undefined),
    resolveCapability: (c) => (c === capabilityCid ? capBundle : undefined),
    resolveAccountAuthorityKey: (a) => (a === 'acct-1' ? accountAuthority.publicKey : undefined),
    resolveRoomAuthorityKey: (r) => (r === 'room-1' ? roomAuthority.publicKey : undefined),
    revocations,
  };
}

describe('device certificate (WS-R.1.1)', () => {
  it('verifies against the account authority and binds the device key', async () => {
    const result = await verifyDeviceCertificate(certBundle, accountAuthority.publicKey, {
      networkId: NETWORK,
      nowMs: NOW,
    });
    expect(result).toMatchObject({ ok: true, accountId: 'acct-1', deviceKeyId: 'key-1' });
  });

  it('rejects a forged authority (wrong key), expiry, and a stale account epoch', async () => {
    const forged = await verifyDeviceCertificate(certBundle, roomAuthority.publicKey, {
      networkId: NETWORK,
      nowMs: NOW,
    });
    expect(forged).toEqual({ ok: false, status: 'rejected_bad_authority_proof' });
    const expired = await verifyDeviceCertificate(certBundle, accountAuthority.publicKey, {
      networkId: NETWORK,
      nowMs: NOW + 2_000_000,
    });
    expect(expired).toEqual({ ok: false, status: 'rejected_expired' });
    const stale = await verifyDeviceCertificate(certBundle, accountAuthority.publicKey, {
      networkId: NETWORK,
      nowMs: NOW,
      minAccountEpoch: 2,
    });
    expect(stale).toEqual({ ok: false, status: 'rejected_stale_account_epoch' });
  });
});

describe('capability (WS-R.1.2)', () => {
  it('verifies and gates operation / scope / room / subject', async () => {
    const verified = await verifyCapability(capBundle, roomAuthority.publicKey, {
      networkId: NETWORK,
      nowMs: NOW,
    });
    expect(verified.ok).toBe(true);

    const base = {
      roomId: 'room-1',
      subjectAccountId: 'acct-1',
      subjectDeviceKeyId: 'key-1',
    } as const;
    expect(
      capabilityAuthorizes(capBundle.capability, {
        ...base,
        visibilityScope: 'in_room',
        operation: 'post',
      }),
    ).toEqual({ ok: true });
    // public is narrower than in_room → allowed; private is wider → denied.
    expect(
      capabilityAuthorizes(capBundle.capability, {
        ...base,
        visibilityScope: 'public',
        operation: 'post',
      }),
    ).toEqual({ ok: true });
    expect(
      capabilityAuthorizes(capBundle.capability, {
        ...base,
        visibilityScope: 'private',
        operation: 'post',
      }),
    ).toEqual({ ok: false, denial: 'visibility_denied' });
    expect(
      capabilityAuthorizes(capBundle.capability, {
        ...base,
        visibilityScope: 'in_room',
        operation: 'moderate',
      }),
    ).toEqual({ ok: false, denial: 'operation_denied' });
    expect(
      capabilityAuthorizes(capBundle.capability, {
        ...base,
        roomId: 'room-2',
        visibilityScope: 'in_room',
        operation: 'post',
      }),
    ).toEqual({ ok: false, denial: 'room_mismatch' });
  });
});

describe('device sequence chain + capability usage (WS-R.1.3)', () => {
  it('is monotone per device and hash-links via prev_device_record_cid', () => {
    const chain = new DeviceSequenceChain();
    expect(chain.peekNext('key-1')).toEqual({ deviceSeq: 0 });
    chain.commit('key-1', 0, 'lcapr_aaa');
    expect(chain.peekNext('key-1')).toEqual({ deviceSeq: 1, prevDeviceRecordCid: 'lcapr_aaa' });
    chain.commit('key-1', 1, 'lcapr_bbb');
    // A different device keeps an independent counter.
    expect(chain.peekNext('key-2')).toEqual({ deviceSeq: 0 });
    expect(() => chain.commit('key-1', 5, 'lcapr_ccc')).toThrow(/non-monotone/);
  });

  it('debits quota per capability_cid, independent of the sequence', () => {
    const tracker = new CapabilityUsageTracker();
    expect(tracker.consume('cap-a', quotas, 100, 0)).toMatchObject({ ok: true });
    expect(tracker.consume('cap-a', quotas, 100, 0)).toMatchObject({ ok: true });
    // A second capability accumulates separately.
    expect(tracker.consume('cap-b', quotas, 100, 0).ok).toBe(true);
    expect(tracker.current('cap-a').events).toBe(2);
    expect(tracker.current('cap-b').events).toBe(1);
    expect(tracker.consume('cap-a', quotas, 500, 0)).toEqual({
      ok: false,
      reason: 'max_single_event_bytes',
    });
    expect(tracker.consume('cap-a', quotas, 100, 0).ok).toBe(true); // 3rd event
    expect(tracker.consume('cap-a', quotas, 100, 0)).toEqual({
      ok: false,
      reason: 'max_offline_events',
    });
  });
});

describe('revocation index (WS-R.1.4)', () => {
  it('indexes, looks up, tracks the frontier, and classes P0', () => {
    const index = new RevocationIndex();
    expect(index.isRevoked('device', 'key-1')).toBe(false);
    index.index({
      record_version: 2,
      kind: 'revocation',
      revocation_id: 'rev-1',
      revoked_kind: 'device',
      revoked_id: 'key-1',
      effective_at_ms: NOW,
      revocation_epoch: 5,
      replacement_cid: 'lcapr_replacement',
    });
    expect(index.isRevoked('device', 'key-1')).toBe(true);
    expect(index.lookup('device', 'key-1')?.replacement_cid).toBe('lcapr_replacement');
    expect(index.knownEpoch).toBe(5);
    expect(defaultLane(revocationPriority())).toBe('C0');
  });
});

describe('identity-chain validation (WS-R.1.5)', () => {
  it('authorizes a fully valid chain', async () => {
    const result = await validateIdentityChain(contribution, makeDeps(), {
      networkId: NETWORK,
      nowMs: NOW,
    });
    expect(result.status).toBe('authorized');
    if (result.status === 'authorized') {
      expect(result.facts).toMatchObject({
        roomId: 'room-1',
        operation: 'post',
        capabilityId: 'cap-1',
      });
      expect(result.revocationFrontierStale).toBe(false);
    }
  });

  it('quarantines with the precise missing dependency', async () => {
    const noCert: IdentityChainDeps = { ...makeDeps(), resolveCertificate: () => undefined };
    const r1 = await validateIdentityChain(contribution, noCert, {
      networkId: NETWORK,
      nowMs: NOW,
    });
    expect(r1).toEqual({
      status: 'quarantined',
      missing: [{ kind: 'device_certificate', deviceKeyId: 'key-1' }],
    });

    const noCap: IdentityChainDeps = { ...makeDeps(), resolveCapability: () => undefined };
    const r2 = await validateIdentityChain(contribution, noCap, { networkId: NETWORK, nowMs: NOW });
    expect(r2).toEqual({
      status: 'quarantined',
      missing: [{ kind: 'capability', cid: capabilityCid }],
    });
  });

  it('rejects an expired certificate and an operation-denied capability', async () => {
    const expired = await validateIdentityChain(contribution, makeDeps(), {
      networkId: NETWORK,
      nowMs: NOW + 2_000_000,
    });
    expect(expired).toEqual({
      status: 'rejected',
      reason: { stage: 'certificate', status: 'rejected_expired' },
    });

    const moderation: ContributionEventRecordV2 = {
      ...contribution,
      event_type: 'moderation_action',
    };
    const denied = await validateIdentityChain(moderation, makeDeps(), {
      networkId: NETWORK,
      nowMs: NOW,
    });
    expect(denied).toEqual({
      status: 'rejected',
      reason: { stage: 'authorization', denial: 'operation_denied' },
    });
  });

  it('reports revoked regardless of an otherwise-valid chain', async () => {
    const revocations = new RevocationIndex();
    revocations.index({
      record_version: 2,
      kind: 'revocation',
      revocation_id: 'rev-x',
      revoked_kind: 'device',
      revoked_id: 'key-1',
      effective_at_ms: NOW,
      revocation_epoch: 9,
    });
    const result = await validateIdentityChain(contribution, makeDeps(revocations), {
      networkId: NETWORK,
      nowMs: NOW,
    });
    expect(result).toMatchObject({ status: 'revoked', target: { kind: 'device', id: 'key-1' } });
  });

  it('flags a stale revocation frontier without rejecting', async () => {
    const highFloorCap: CapabilityBundle = {
      ...capBundle,
      capability: { ...capBundle.capability, revocation_epoch_floor: 100 },
    };
    const deps: IdentityChainDeps = { ...makeDeps(), resolveCapability: () => highFloorCap };
    const result = await validateIdentityChain(contribution, deps, {
      networkId: NETWORK,
      nowMs: NOW,
    });
    expect(result.status).toBe('authorized');
    if (result.status === 'authorized') expect(result.revocationFrontierStale).toBe(true);
  });
});

describe('verifyRevocationAuthority (§11.5, WS-R.1.4)', () => {
  const ACCOUNT = 'acct-rev';
  const ROOM = 'room-rev';
  const SIGNER = 'acct-authority-rev';

  async function mint(
    over: Partial<RevocationRecordV2> & { revoked_kind: RevocationRecordV2['revoked_kind'] },
    signer: DeviceKeyPair,
    signerKeyId: string,
  ): Promise<{
    revocation: RevocationRecordV2;
    body: Uint8Array;
    proof: Awaited<ReturnType<typeof buildAndSign>>;
  }> {
    const revocation: RevocationRecordV2 = {
      record_version: 2,
      kind: 'revocation',
      revocation_id: 'rev-x',
      revoked_id: 'target-x',
      effective_at_ms: NOW - 100,
      revocation_epoch: 1,
      ...over,
    };
    const body = encodeWithSchema(revocationRecordV2Schema, revocation);
    const proof = await buildAndSign({
      privateKey: signer.privateKey,
      signerKeyId,
      proofKind: 'authority_signature',
      recordKind: 'revocation',
      recordBody: body,
      networkId: NETWORK,
    });
    return { revocation, body, proof };
  }

  it('maps revoked kinds to the governing authority scope', () => {
    expect(revocationAuthorityScope('device')).toBe('account');
    expect(revocationAuthorityScope('account')).toBe('account');
    expect(revocationAuthorityScope('proof')).toBe('account');
    expect(revocationAuthorityScope('capability')).toBe('room');
    expect(revocationAuthorityScope('room_policy')).toBe('room');
  });

  it('accepts an account-authority-signed device revocation in scope', async () => {
    const { revocation, body, proof } = await mint(
      { revoked_kind: 'device', revoked_id: 'dev-1', account_id: ACCOUNT },
      accountAuthority,
      SIGNER,
    );
    const binding: RevocationAuthorityBinding = {
      key: accountAuthority.publicKey,
      scope: 'account',
      scopeId: ACCOUNT,
    };
    const res = await verifyRevocationAuthority({
      revocation,
      body,
      proof,
      resolveAuthority: (id) => (id === SIGNER ? binding : undefined),
      networkId: NETWORK,
    });
    expect(res).toEqual({ ok: true, scope: 'account', scopeId: ACCOUNT });
  });

  it('rejects a non-authority proof kind', async () => {
    const { revocation, body } = await mint(
      { revoked_kind: 'device', revoked_id: 'dev-1', account_id: ACCOUNT },
      accountAuthority,
      SIGNER,
    );
    const deviceProof = await buildAndSign({
      privateKey: accountAuthority.privateKey,
      signerKeyId: SIGNER,
      proofKind: 'device_signature', // wrong kind
      recordKind: 'revocation',
      recordBody: body,
      networkId: NETWORK,
    });
    const res = await verifyRevocationAuthority({
      revocation,
      body,
      proof: deviceProof,
      resolveAuthority: () => ({
        key: accountAuthority.publicKey,
        scope: 'account',
        scopeId: ACCOUNT,
      }),
      networkId: NETWORK,
    });
    expect(res).toEqual({ ok: false, status: 'rejected_wrong_proof_kind' });
  });

  it('rejects a revocation that names no governing id (missing scope binding)', async () => {
    const { revocation, body, proof } = await mint(
      { revoked_kind: 'device', revoked_id: 'dev-1' }, // no account_id
      accountAuthority,
      SIGNER,
    );
    const res = await verifyRevocationAuthority({
      revocation,
      body,
      proof,
      resolveAuthority: () => ({
        key: accountAuthority.publicKey,
        scope: 'account',
        scopeId: ACCOUNT,
      }),
      networkId: NETWORK,
    });
    expect(res).toEqual({ ok: false, status: 'rejected_missing_scope_binding' });
  });

  it('rejects an unknown authority signer', async () => {
    const { revocation, body, proof } = await mint(
      { revoked_kind: 'device', revoked_id: 'dev-1', account_id: ACCOUNT },
      accountAuthority,
      SIGNER,
    );
    const res = await verifyRevocationAuthority({
      revocation,
      body,
      proof,
      resolveAuthority: () => undefined, // signer not registered
      networkId: NETWORK,
    });
    expect(res).toEqual({ ok: false, status: 'rejected_unknown_authority' });
  });

  it('rejects an authority whose scope/id does not govern the target', async () => {
    // A ROOM authority cannot sign a device (account-scoped) revocation.
    const { revocation, body, proof } = await mint(
      { revoked_kind: 'device', revoked_id: 'dev-1', account_id: ACCOUNT },
      accountAuthority,
      SIGNER,
    );
    const res = await verifyRevocationAuthority({
      revocation,
      body,
      proof,
      resolveAuthority: () => ({ key: accountAuthority.publicKey, scope: 'room', scopeId: ROOM }),
      networkId: NETWORK,
    });
    expect(res).toEqual({ ok: false, status: 'rejected_authority_scope_mismatch' });
  });

  it('rejects a forged signature (right scope, wrong key)', async () => {
    const imposter = await generateDeviceKey();
    const { revocation, body } = await mint(
      { revoked_kind: 'device', revoked_id: 'dev-1', account_id: ACCOUNT },
      accountAuthority,
      SIGNER,
    );
    const forged = await buildAndSign({
      privateKey: imposter.privateKey, // signed by the imposter …
      signerKeyId: SIGNER, // … but claims the authority signer id
      proofKind: 'authority_signature',
      recordKind: 'revocation',
      recordBody: body,
      networkId: NETWORK,
    });
    const res = await verifyRevocationAuthority({
      revocation,
      body,
      proof: forged,
      // resolve to the GENUINE authority key — the forged signature must fail against it
      resolveAuthority: () => ({
        key: accountAuthority.publicKey,
        scope: 'account',
        scopeId: ACCOUNT,
      }),
      networkId: NETWORK,
    });
    expect(res).toEqual({ ok: false, status: 'rejected_bad_authority_proof' });
  });
});

describe('verifyExportAuthorization (§29.8 export gate, WS-R.1)', () => {
  async function signedRequest(capCid: string): Promise<{
    request: ExportRequestV2;
    body: Uint8Array;
    proof: Awaited<ReturnType<typeof buildAndSign>>;
  }> {
    const request: ExportRequestV2 = {
      record_version: 2,
      kind: 'export_request',
      room_id: 'room-1',
      capability_cid: capCid,
      issued_at_ms: NOW,
      request_nonce: new Uint8Array([4, 3, 2, 1]),
    };
    const body = encodeWithSchema(exportRequestV2Schema, request);
    const proof = await buildAndSign({
      privateKey: device.privateKey,
      signerKeyId: 'key-1',
      proofKind: 'device_signature',
      recordKind: 'export_request',
      recordBody: body,
      networkId: NETWORK,
    });
    return { request, body, proof };
  }

  const deps = (revocations = new RevocationIndex()) => ({
    resolveCapability: (c: string) => (c === capabilityCid ? capBundle : undefined),
    resolveRoomAuthorityKey: (r: string) => (r === 'room-1' ? roomAuthority.publicKey : undefined),
    resolveDevicePublicKey: (d: string) => (d === 'key-1' ? device.publicKey : undefined),
    revocations,
  });

  it('authorizes a fresh, device-signed request citing a may_export_bundle capability', async () => {
    const { request, body, proof } = await signedRequest(capabilityCid);
    const res = await verifyExportAuthorization({
      request,
      body,
      proof,
      deps: deps(),
      ctx: { networkId: NETWORK, nowMs: NOW },
    });
    expect(res).toEqual({ ok: true, roomId: 'room-1', capabilityId: 'cap-1' });
  });

  it('denies a request whose capability forbids bundle export', async () => {
    const noExportCap = await issueCapability({
      authorityPrivateKey: roomAuthority.privateKey,
      authoritySignerKeyId: 'room-authority-1',
      capability: {
        ...capBundle.capability,
        capability_id: 'cap-no-export',
        transfer_policy: { ...capBundle.capability.transfer_policy, may_export_bundle: false },
      },
      networkId: NETWORK,
    });
    const noExportCid = await cidFor('record', noExportCap.body);
    const { request, body, proof } = await signedRequest(noExportCid);
    const res = await verifyExportAuthorization({
      request,
      body,
      proof,
      deps: {
        resolveCapability: (c) => (c === noExportCid ? noExportCap : undefined),
        resolveRoomAuthorityKey: () => roomAuthority.publicKey,
        resolveDevicePublicKey: () => device.publicKey,
        revocations: new RevocationIndex(),
      },
      ctx: { networkId: NETWORK, nowMs: NOW },
    });
    expect(res).toEqual({ ok: false, status: 'rejected_export_not_permitted' });
  });

  it('denies a request whose device has been revoked', async () => {
    const revocations = new RevocationIndex();
    revocations.index({
      record_version: 2,
      kind: 'revocation',
      revocation_id: 'r1',
      revoked_kind: 'device',
      revoked_id: 'key-1',
      account_id: 'acct-1',
      effective_at_ms: NOW - 1,
      revocation_epoch: 1,
    });
    const { request, body, proof } = await signedRequest(capabilityCid);
    const res = await verifyExportAuthorization({
      request,
      body,
      proof,
      deps: deps(revocations),
      ctx: { networkId: NETWORK, nowMs: NOW },
    });
    expect(res).toEqual({ ok: false, status: 'rejected_revoked' });
  });
});
