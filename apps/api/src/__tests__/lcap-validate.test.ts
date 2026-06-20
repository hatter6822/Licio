// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.1b — server-COMPUTED validation.  The in-memory ingestion engine runs the
// SAME `validate()` the client uses, over its REGISTERED identity state (device
// certificate, room capability, account/room authority keys, revocations), and
// feeds the verdict into the commit stage.  No injected verdict here: the outcome
// follows only from cryptography + registered authority, never the arrival path.

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
import { beforeAll, describe, expect, it } from 'vitest';
import { LcapIngestServer } from '../lcap/server-ingest.js';

const NET = 'prod';
const NOW = 1_000_000;
const ROOM = 'room-1';
const DEVICE_KEY = 'key-1';

let accountAuthority: DeviceKeyPair;
let roomAuthority: DeviceKeyPair;
let device: DeviceKeyPair;
let certBundle: CertificateBundle;
let capBundle: CapabilityBundle;
let capabilityCid: string;
let body: Uint8Array;
let recordCid: string;
let proof: DetachedProofV2;

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
      device_key_id: DEVICE_KEY,
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
      subject_device_key_id: DEVICE_KEY,
      room_id: ROOM,
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

  const contribution: ContributionEventRecordV2 = {
    record_version: 2,
    kind: 'contribution_event',
    event_type: 'post',
    home_room_id: ROOM,
    visibility_scope: 'in_room',
    author_account_id: 'acct-1',
    author_device_id: 'dev-1',
    author_device_key_id: DEVICE_KEY,
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
    signerKeyId: DEVICE_KEY,
    proofKind: 'device_signature',
    recordKind: 'contribution_event',
    recordBody: body,
    networkId: NET,
  });
});

/** A server with the identity chain registered (room capability optional). */
async function serverWith(opts: { capability?: boolean } = {}): Promise<LcapIngestServer> {
  const srv = new LcapIngestServer(NET, () => NOW);
  await srv.registerCertificate(certBundle);
  srv.registerAccountAuthorityKey('acct-1', 1, accountAuthority.publicKey);
  srv.registerRoomAuthorityKey(ROOM, 2, roomAuthority.publicKey);
  if (opts.capability !== false) await srv.registerCapability(capBundle);
  return srv;
}

const base = () => ({
  recordCid,
  roomId: ROOM,
  authorDeviceKeyId: DEVICE_KEY,
  deviceSeq: 0,
  body,
  proofs: [proof],
});

describe('LcapIngestServer — server-computed validation (R.12.1b)', () => {
  it('accepts a record with a fully valid identity chain (no injected verdict)', async () => {
    const srv = await serverWith();
    const res = await srv.commitRecord(base());
    expect(res.status.status).toBe('accepted');
    expect(res.roomSeq).toBe(0);
    expect(srv.isAccepted(recordCid)).toBe(true);
  });

  it('quarantines and wants the capability when it is not registered', async () => {
    const srv = await serverWith({ capability: false });
    const res = await srv.commitRecord(base());
    expect(res.status.status).toBe('quarantined_missing_dependency');
    expect(res.status.missing_cids).toContain(capabilityCid);
    expect(res.wants.some((w) => w.cid === capabilityCid)).toBe(true);
    expect(srv.isAccepted(recordCid)).toBe(false);
  });

  it('rejects a record signed by a key other than its certified device key', async () => {
    const srv = await serverWith();
    const imposter = await generateDeviceKey();
    const forgedProof = await buildAndSign({
      privateKey: imposter.privateKey,
      signerKeyId: DEVICE_KEY, // claims the certified key id …
      proofKind: 'device_signature',
      recordKind: 'contribution_event',
      recordBody: body, // … over the same body
      networkId: NET,
    });
    const res = await srv.commitRecord({ ...base(), proofs: [forgedProof] });
    expect(res.status.status).toBe('rejected_bad_signature');
    expect(srv.isAccepted(recordCid)).toBe(false);
  });

  it('rejects a record whose device key has been revoked', async () => {
    const srv = await serverWith();
    srv.registerRevocation({
      record_version: 2,
      kind: 'revocation',
      revocation_id: 'rev-1',
      revoked_kind: 'device',
      revoked_id: DEVICE_KEY,
      effective_at_ms: NOW - 500,
      revocation_epoch: 1,
    });
    const res = await srv.commitRecord(base());
    expect(res.status.status).toBe('rejected_revoked');
    expect(srv.isAccepted(recordCid)).toBe(false);
  });

  it('computes the verdict per record inside commitBatch (no injected verdicts)', async () => {
    const srv = await serverWith();
    const { statuses } = await srv.commitBatch([base()]);
    expect(statuses[0]?.status).toBe('accepted');
    expect(srv.roomSize(ROOM)).toBe(1);
  });
});
