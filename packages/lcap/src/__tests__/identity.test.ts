// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.1 — identity, certificates, capabilities, revocations, and the §18.3
// steps-6-11 chain validator.  Full-chain accept plus every broken-link case
// (missing / expired / forged / denied / revoked) with the right status and
// missing dependencies.

import { beforeAll, describe, expect, it } from 'vitest';
import { cidFor } from '../cid/index.js';
import { type DeviceKeyPair, exportPublicKeyCose, generateDeviceKey } from '../cose/keys.js';
import {
  type CapabilityBundle,
  CapabilityUsageTracker,
  type CertificateBundle,
  capabilityAuthorizes,
  DeviceSequenceChain,
  type IdentityChainDeps,
  issueCapability,
  issueDeviceCertificate,
  RevocationIndex,
  validateIdentityChain,
  verifyCapability,
  verifyDeviceCertificate,
} from '../identity/index.js';
import { revocationPriority } from '../identity/revocation.js';
import { defaultLane } from '../priority.js';
import type { CapabilityRecordV2, ContributionEventRecordV2 } from '../schemas/records.js';

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
