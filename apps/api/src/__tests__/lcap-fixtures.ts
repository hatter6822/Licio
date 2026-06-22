// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared LCAP crypto fixtures for the server-ingestion tests (WS-R.12).  Mints a
// real account/room authority + device key, a device certificate, a room
// capability, and a signed contribution event + its detached proof — the minimal
// valid identity chain `validate()` needs to reach `authorized_provisional`.

import {
  buildAndSign,
  type CapabilityBundle,
  type CapabilityRecordV2,
  type CertificateBundle,
  type ContributionEventRecordV2,
  cidFor,
  type DetachedProofV2,
  type DeviceKeyPair,
  detachedProofV2Schema,
  type ExportRequestV2,
  encodeContributionEvent,
  encodeWithSchema,
  exportPublicKeyCose,
  exportRequestEnvelopeV2Schema,
  exportRequestV2Schema,
  generateDeviceKey,
  issueCapability,
  issueDeviceCertificate,
  type RevocationRecordV2,
  revocationRecordV2Schema,
} from '@licio/lcap';
import type { LcapIngestServer } from '../lcap/server-ingest.js';

export const NET = 'prod';
export const NOW = 1_000_000;
export const ROOM = 'room-1';
export const DEVICE_KEY = 'key-1';
export const ACCOUNT = 'acct-1';
export const ACCOUNT_EPOCH = 1;
export const ACCOUNT_AUTHORITY_SIGNER = 'account-authority-1';
export const ROOM_AUTHORITY_SIGNER = 'room-authority-1';
export const POLICY_EPOCH = 2;

export interface LcapFixtures {
  readonly accountAuthority: DeviceKeyPair;
  readonly roomAuthority: DeviceKeyPair;
  readonly device: DeviceKeyPair;
  readonly certBundle: CertificateBundle;
  readonly capBundle: CapabilityBundle;
  readonly capabilityCid: string;
  readonly contribution: ContributionEventRecordV2;
  readonly body: Uint8Array;
  readonly recordCid: string;
  readonly proof: DetachedProofV2;
}

/** Mint the full valid identity chain + a signed contribution. */
export async function buildLcapFixtures(): Promise<LcapFixtures> {
  const accountAuthority = await generateDeviceKey();
  const roomAuthority = await generateDeviceKey();
  const device = await generateDeviceKey();

  const certBundle = await issueDeviceCertificate({
    authorityPrivateKey: accountAuthority.privateKey,
    authoritySignerKeyId: ACCOUNT_AUTHORITY_SIGNER,
    certificate: {
      record_version: 2,
      kind: 'device_certificate',
      account_id: ACCOUNT,
      device_id: 'dev-1',
      device_key_id: DEVICE_KEY,
      public_key_cose: await exportPublicKeyCose(device.publicKey),
      issued_at_ms: NOW - 1000,
      not_before_ms: NOW - 1000,
      not_after_ms: NOW + 1_000_000,
      issuer: 'licio_account_authority',
      account_epoch: ACCOUNT_EPOCH,
    },
    networkId: NET,
  });

  const capBundle = await issueCapability({
    authorityPrivateKey: roomAuthority.privateKey,
    authoritySignerKeyId: ROOM_AUTHORITY_SIGNER,
    capability: {
      record_version: 2,
      kind: 'room_capability',
      capability_id: 'cap-1',
      subject_account_id: ACCOUNT,
      subject_device_id: 'dev-1',
      subject_device_key_id: DEVICE_KEY,
      room_id: ROOM,
      visibility_scope: 'in_room',
      operations: ['post', 'reply'],
      policy_epoch: POLICY_EPOCH,
      revocation_epoch_floor: 0,
      not_before_ms: NOW - 1000,
      not_after_ms: NOW + 1_000_000,
      quotas: {
        max_offline_events: 10,
        max_total_payload_bytes: 10000,
        max_single_event_bytes: 1000,
        // A realistic media allowance: a posting capability admits referenced media blocks
        // (the §18.3 step 9 media-byte charge), comfortably above the tiny test blocks.  The
        // media-quota tests override this with a tight budget to exercise the over-budget path.
        max_media_bytes: 1_000_000,
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
  const capabilityCid = await cidFor('record', capBundle.body);

  const contribution: ContributionEventRecordV2 = {
    record_version: 2,
    kind: 'contribution_event',
    event_type: 'post',
    home_room_id: ROOM,
    visibility_scope: 'in_room',
    author_account_id: ACCOUNT,
    author_device_id: 'dev-1',
    author_device_key_id: DEVICE_KEY,
    device_seq: 0,
    capability_cid: capabilityCid,
    policy_epoch_claim: POLICY_EPOCH,
    revocation_epoch_claim: 0,
    client_nonce: new Uint8Array([1, 2, 3, 4]),
    priority: 1,
  };
  const body = encodeContributionEvent(contribution);
  const recordCid = await cidFor('record', body);
  const proof = await buildAndSign({
    privateKey: device.privateKey,
    signerKeyId: DEVICE_KEY,
    proofKind: 'device_signature',
    recordKind: 'contribution_event',
    recordBody: body,
    networkId: NET,
  });

  return {
    accountAuthority,
    roomAuthority,
    device,
    certBundle,
    capBundle,
    capabilityCid,
    contribution,
    body,
    recordCid,
    proof,
  };
}

/** Register the identity chain into a server (room capability optional). */
export async function registerIdentity(
  server: LcapIngestServer,
  fx: LcapFixtures,
  opts: { capability?: boolean } = {},
): Promise<void> {
  // The root-of-trust authority keys MUST be registered before the certificate: a cert is
  // only indexed once its account-authority proof verifies against the registered key.
  server.registerAccountAuthorityKey(
    ACCOUNT,
    ACCOUNT_EPOCH,
    fx.accountAuthority.publicKey,
    ACCOUNT_AUTHORITY_SIGNER,
  );
  server.registerRoomAuthorityKey(
    ROOM,
    POLICY_EPOCH,
    fx.roomAuthority.publicKey,
    ROOM_AUTHORITY_SIGNER,
  );
  await server.registerCertificate(fx.certBundle);
  if (opts.capability !== false) await server.registerCapability(fx.capBundle);
}

/**
 * Mint an account-authority-signed device revocation + its detached proof, ready to feed
 * `registerRevocation` (the account authority governs device-scoped revocations, §11.5).
 */
export async function mintDeviceRevocation(
  fx: LcapFixtures,
  params: { revokedDeviceKeyId: string; revocationEpoch: number; revocationId?: string },
): Promise<{ revocation: RevocationRecordV2; body: Uint8Array; proof: DetachedProofV2 }> {
  const revocation: RevocationRecordV2 = {
    record_version: 2,
    kind: 'revocation',
    revocation_id: params.revocationId ?? `rev-${params.revokedDeviceKeyId}`,
    revoked_kind: 'device',
    revoked_id: params.revokedDeviceKeyId,
    account_id: ACCOUNT, // the account authority for ACCOUNT governs its device revocations
    effective_at_ms: NOW - 500,
    revocation_epoch: params.revocationEpoch,
  };
  const body = encodeWithSchema(revocationRecordV2Schema, revocation);
  const proof = await buildAndSign({
    privateKey: fx.accountAuthority.privateKey,
    signerKeyId: ACCOUNT_AUTHORITY_SIGNER,
    proofKind: 'authority_signature',
    recordKind: 'revocation',
    recordBody: body,
    networkId: NET,
  });
  return { revocation, body, proof };
}

/**
 * Mint a device-signed `export_request` envelope (the §29.8 export gate input): the
 * subject device signs a freshness-windowed request citing a `may_export_bundle`
 * capability for the room.  Returns the encoded envelope bytes to POST to /bundles/export.
 */
export async function mintExportRequest(
  fx: LcapFixtures,
  params: {
    roomId?: string;
    capabilityCid?: string;
    issuedAtMs?: number;
    nonce?: Uint8Array;
    signer?: DeviceKeyPair;
    signerKeyId?: string;
  } = {},
): Promise<Uint8Array> {
  const request: ExportRequestV2 = {
    record_version: 2,
    kind: 'export_request',
    room_id: params.roomId ?? ROOM,
    capability_cid: params.capabilityCid ?? fx.capabilityCid,
    issued_at_ms: params.issuedAtMs ?? NOW,
    request_nonce: params.nonce ?? new Uint8Array([9, 8, 7, 6]),
  };
  const body = encodeWithSchema(exportRequestV2Schema, request);
  const proof = await buildAndSign({
    privateKey: (params.signer ?? fx.device).privateKey,
    signerKeyId: params.signerKeyId ?? DEVICE_KEY,
    proofKind: 'device_signature',
    recordKind: 'export_request',
    recordBody: body,
    networkId: NET,
  });
  const proofBody = encodeWithSchema(detachedProofV2Schema, proof);
  return encodeWithSchema(exportRequestEnvelopeV2Schema, { request, proof_body: proofBody });
}

/**
 * Mint a room capability with quota (and id) overrides, signed by the fixture room
 * authority — for exercising the §18.3 step 9 aggregate-quota enforcement.
 */
export async function mintCapability(
  fx: LcapFixtures,
  overrides: {
    capabilityId?: string;
    quotas?: Partial<CapabilityRecordV2['quotas']>;
  } = {},
): Promise<{ bundle: CapabilityBundle; cid: string }> {
  const bundle = await issueCapability({
    authorityPrivateKey: fx.roomAuthority.privateKey,
    authoritySignerKeyId: ROOM_AUTHORITY_SIGNER,
    capability: {
      ...fx.capBundle.capability,
      capability_id: overrides.capabilityId ?? 'cap-custom',
      quotas: { ...fx.capBundle.capability.quotas, ...overrides.quotas },
    },
    networkId: NET,
  });
  return { bundle, cid: await cidFor('record', bundle.body) };
}

/**
 * Mint a device-signed contribution at a given device sequence citing `capabilityCid` —
 * for building a multi-event device chain (e.g. to exhaust a capability's event quota).
 */
export async function mintContribution(
  fx: LcapFixtures,
  params: {
    deviceSeq: number;
    capabilityCid: string;
    prevDeviceRecordCid?: string;
    text?: string;
    sourceSnapshotCids?: readonly string[];
  },
): Promise<{ recordCid: string; body: Uint8Array; proof: DetachedProofV2 }> {
  const contribution: ContributionEventRecordV2 = {
    record_version: 2,
    kind: 'contribution_event',
    event_type: 'post',
    home_room_id: ROOM,
    visibility_scope: 'in_room',
    author_account_id: ACCOUNT,
    author_device_id: 'dev-1',
    author_device_key_id: DEVICE_KEY,
    device_seq: params.deviceSeq,
    capability_cid: params.capabilityCid,
    policy_epoch_claim: POLICY_EPOCH,
    revocation_epoch_claim: 0,
    client_nonce: new Uint8Array([params.deviceSeq + 1, 2, 3, 4]),
    priority: 1,
    ...(params.prevDeviceRecordCid !== undefined
      ? { prev_device_record_cid: params.prevDeviceRecordCid }
      : {}),
    ...(params.sourceSnapshotCids !== undefined
      ? { source_snapshot_cids: [...params.sourceSnapshotCids] }
      : {}),
  };
  const body = encodeContributionEvent(contribution);
  const proof = await buildAndSign({
    privateKey: fx.device.privateKey,
    signerKeyId: DEVICE_KEY,
    proofKind: 'device_signature',
    recordKind: 'contribution_event',
    recordBody: body,
    networkId: NET,
  });
  return { recordCid: await cidFor('record', body), body, proof };
}
