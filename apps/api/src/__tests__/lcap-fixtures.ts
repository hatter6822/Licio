// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared LCAP crypto fixtures for the server-ingestion tests (WS-R.12).  Mints a
// real account/room authority + device key, a device certificate, a room
// capability, and a signed contribution event + its detached proof — the minimal
// valid identity chain `validate()` needs to reach `authorized_provisional`.

import {
  buildAndSign,
  type CapabilityBundle,
  type CertificateBundle,
  type ContributionEventRecordV2,
  cidFor,
  type DetachedProofV2,
  type DeviceKeyPair,
  encodeContributionEvent,
  exportPublicKeyCose,
  generateDeviceKey,
  issueCapability,
  issueDeviceCertificate,
} from '@licio/lcap';
import type { LcapIngestServer } from '../lcap/server-ingest.js';

export const NET = 'prod';
export const NOW = 1_000_000;
export const ROOM = 'room-1';
export const DEVICE_KEY = 'key-1';
export const ACCOUNT = 'acct-1';
export const ACCOUNT_EPOCH = 1;
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
    authoritySignerKeyId: 'account-authority-1',
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
    authoritySignerKeyId: 'room-authority-1',
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
  server.registerAccountAuthorityKey(ACCOUNT, ACCOUNT_EPOCH, fx.accountAuthority.publicKey);
  server.registerRoomAuthorityKey(ROOM, POLICY_EPOCH, fx.roomAuthority.publicKey);
  await server.registerCertificate(fx.certBundle);
  if (opts.capability !== false) await server.registerCapability(fx.capBundle);
}
