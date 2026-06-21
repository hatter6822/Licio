// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.1b — server-COMPUTED validation.  The in-memory ingestion engine runs the
// SAME `validate()` the client uses, over its REGISTERED identity state (device
// certificate, room capability, account/room authority keys, revocations), and
// feeds the verdict into the commit stage.  No injected verdict here: the outcome
// follows only from cryptography + registered authority, never the arrival path.

import {
  buildAndSign,
  exportPublicKeyCose,
  generateDeviceKey,
  issueDeviceCertificate,
} from '@licio/lcap';
import { beforeAll, describe, expect, it } from 'vitest';
import { LcapIngestServer } from '../lcap/server-ingest.js';
import {
  buildLcapFixtures,
  DEVICE_KEY,
  type LcapFixtures,
  NET,
  NOW,
  ROOM,
  registerIdentity,
} from './lcap-fixtures.js';

let fx: LcapFixtures;

beforeAll(async () => {
  fx = await buildLcapFixtures();
});

/** A server with the identity chain registered (room capability optional). */
async function serverWith(opts: { capability?: boolean } = {}): Promise<LcapIngestServer> {
  const srv = new LcapIngestServer(NET, () => NOW);
  await registerIdentity(srv, fx, opts);
  return srv;
}

const base = () => ({
  recordCid: fx.recordCid,
  roomId: ROOM,
  authorDeviceKeyId: DEVICE_KEY,
  deviceSeq: 0,
  body: fx.body,
  proofs: [fx.proof],
});

describe('LcapIngestServer — server-computed validation (R.12.1b)', () => {
  it('accepts a record with a fully valid identity chain (no injected verdict)', async () => {
    const srv = await serverWith();
    const res = await srv.commitRecord(base());
    expect(res.status.status).toBe('accepted');
    expect(res.roomSeq).toBe(0);
    expect(await srv.isAccepted(fx.recordCid)).toBe(true);
  });

  it('quarantines and wants the capability when it is not registered', async () => {
    const srv = await serverWith({ capability: false });
    const res = await srv.commitRecord(base());
    expect(res.status.status).toBe('quarantined_missing_dependency');
    expect(res.status.missing_cids).toContain(fx.capabilityCid);
    expect(res.wants.some((w) => w.cid === fx.capabilityCid)).toBe(true);
    expect(await srv.isAccepted(fx.recordCid)).toBe(false);
  });

  it('rejects a record signed by a key other than its certified device key', async () => {
    const srv = await serverWith();
    const imposter = await generateDeviceKey();
    const forgedProof = await buildAndSign({
      privateKey: imposter.privateKey,
      signerKeyId: DEVICE_KEY, // claims the certified key id …
      proofKind: 'device_signature',
      recordKind: 'contribution_event',
      recordBody: fx.body, // … over the same body
      networkId: NET,
    });
    const res = await srv.commitRecord({ ...base(), proofs: [forgedProof] });
    expect(res.status.status).toBe('rejected_bad_signature');
    expect(await srv.isAccepted(fx.recordCid)).toBe(false);
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
    expect(await srv.isAccepted(fx.recordCid)).toBe(false);
  });

  it('computes the verdict per record inside commitBatch (no injected verdicts)', async () => {
    const srv = await serverWith();
    const { statuses } = await srv.commitBatch([base()]);
    expect(statuses[0]?.status).toBe('accepted');
    expect(await srv.roomSize(ROOM)).toBe(1);
  });

  it('refuses an unverified certificate and never poisons the registered device key (#7b)', async () => {
    const srv = await serverWith();
    // A genuine re-registration verifies against the account authority.
    expect(await srv.registerCertificate(fx.certBundle)).toBe('registered');

    // An attacker forges a certificate binding the SAME device_key_id to ITS OWN public
    // key, "signed" by a key that is NOT the account authority.  If this overwrote
    // certKeys[DEVICE_KEY], the victim's genuine signatures would then fail (DoS).
    const attacker = await generateDeviceKey();
    const forgedCert = await issueDeviceCertificate({
      authorityPrivateKey: attacker.privateKey, // NOT the account-authority key
      authoritySignerKeyId: 'attacker',
      certificate: {
        ...fx.certBundle.certificate,
        public_key_cose: await exportPublicKeyCose(attacker.publicKey),
      },
      networkId: NET,
    });
    expect(await srv.registerCertificate(forgedCert)).toBe('unverified');

    // The victim's genuine contribution still accepts — the device key was NOT displaced.
    const res = await srv.commitRecord(base());
    expect(res.status.status).toBe('accepted');
  });

  it('does not register a certificate whose account-authority key is unknown (#7b)', async () => {
    // No identity registered at all: the root-of-trust authority key is unknown, so even a
    // genuinely-issued cert cannot be trusted yet — it is not indexed (the contribution
    // that cites it will quarantine, not validate against an unverified key).
    const srv = new LcapIngestServer(NET, () => NOW);
    expect(await srv.registerCertificate(fx.certBundle)).toBe('unverified');
  });
});
