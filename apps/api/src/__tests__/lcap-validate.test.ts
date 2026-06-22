// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.1b — server-COMPUTED validation.  The in-memory ingestion engine runs the
// SAME `validate()` the client uses, over its REGISTERED identity state (device
// certificate, room capability, account/room authority keys, revocations), and
// feeds the verdict into the commit stage.  No injected verdict here: the outcome
// follows only from cryptography + registered authority, never the arrival path.

import {
  buildAndSign,
  cidFor,
  encodeWithSchema,
  exportPublicKeyCose,
  generateDeviceKey,
  issueDeviceCertificate,
  type RevocationRecordV2,
  revocationRecordV2Schema,
} from '@licio/lcap';
import { beforeAll, describe, expect, it } from 'vitest';
import { LcapIngestServer } from '../lcap/server-ingest.js';
import { InMemoryLcapServerStore } from '../lcap/store.js';
import {
  ACCOUNT,
  ACCOUNT_AUTHORITY_SIGNER,
  buildLcapFixtures,
  DEVICE_KEY,
  type LcapFixtures,
  mintCapability,
  mintContribution,
  mintDeviceRevocation,
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

  it('rejects a record whose device key has been revoked (authority-signed revocation)', async () => {
    const srv = await serverWith();
    const rev = await mintDeviceRevocation(fx, {
      revokedDeviceKeyId: DEVICE_KEY,
      revocationEpoch: 1,
    });
    expect(await srv.registerRevocation(rev.revocation, rev.body, rev.proof)).toBe('registered');
    const res = await srv.commitRecord(base());
    expect(res.status.status).toBe('rejected_revoked');
    expect(await srv.isAccepted(fx.recordCid)).toBe(false);
  });

  it('refuses an unsigned/forged-authority revocation — no revoke-by-anyone DoS (#7)', async () => {
    const srv = await serverWith();
    // A revocation "signed" by a non-authority key that merely CLAIMS the authority signer
    // id.  If it indexed, any peer could revoke an arbitrary device (the chain trusts the
    // RevocationIndex at step 11 with no downstream re-check).
    const imposter = await generateDeviceKey();
    const revocation: RevocationRecordV2 = {
      record_version: 2,
      kind: 'revocation',
      revocation_id: 'forged-rev',
      revoked_kind: 'device',
      revoked_id: DEVICE_KEY,
      account_id: ACCOUNT,
      effective_at_ms: NOW - 500,
      revocation_epoch: 9,
    };
    const body = encodeWithSchema(revocationRecordV2Schema, revocation);
    const forgedProof = await buildAndSign({
      privateKey: imposter.privateKey, // NOT the account authority …
      signerKeyId: ACCOUNT_AUTHORITY_SIGNER, // … but claims its signer id
      proofKind: 'authority_signature',
      recordKind: 'revocation',
      recordBody: body,
      networkId: NET,
    });
    expect(await srv.registerRevocation(revocation, body, forgedProof)).toBe('unverified');

    // The device was NOT revoked by the forged proof — the victim's contribution accepts.
    const res = await srv.commitRecord(base());
    expect(res.status.status).toBe('accepted');
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

  it('rejects a contribution that exhausts the capability aggregate event quota (§18.3 step 9)', async () => {
    // Register the cert + authority but a capability whose budget is a SINGLE offline event.
    const srv = await serverWith({ capability: false });
    const tight = await mintCapability(fx, {
      capabilityId: 'cap-tight',
      quotas: { max_offline_events: 1 },
    });
    await srv.registerCapability(tight.bundle);
    const e0 = await mintContribution(fx, { deviceSeq: 0, capabilityCid: tight.cid });
    const e1 = await mintContribution(fx, {
      deviceSeq: 1,
      capabilityCid: tight.cid,
      prevDeviceRecordCid: e0.recordCid,
    });

    // The first event fits the budget and is accepted (debiting the single allowed event).
    const r0 = await srv.commitRecord({
      recordCid: e0.recordCid,
      roomId: ROOM,
      authorDeviceKeyId: DEVICE_KEY,
      deviceSeq: 0,
      capabilityCid: tight.cid,
      body: e0.body,
      proofs: [e0.proof],
    });
    expect(r0.status.status).toBe('accepted');

    // The second event is a valid identity chain but exhausts the capability's event budget,
    // so it is rejected `rejected_quota` and never appended (the aggregate quota is enforced).
    const r1 = await srv.commitRecord({
      recordCid: e1.recordCid,
      roomId: ROOM,
      authorDeviceKeyId: DEVICE_KEY,
      deviceSeq: 1,
      capabilityCid: tight.cid,
      body: e1.body,
      proofs: [e1.proof],
    });
    expect(r1.status.status).toBe('rejected_quota');
    expect(r1.receiptType).toBe('rejected');
    expect(await srv.isAccepted(e1.recordCid)).toBe(false);
  });

  it('accepts a second event when the capability budget allows more than one (no false quota)', async () => {
    const srv = await serverWith({ capability: false });
    const cap = await mintCapability(fx, {
      capabilityId: 'cap-roomy',
      quotas: { max_offline_events: 2 },
    });
    await srv.registerCapability(cap.bundle);
    const e0 = await mintContribution(fx, { deviceSeq: 0, capabilityCid: cap.cid });
    const e1 = await mintContribution(fx, {
      deviceSeq: 1,
      capabilityCid: cap.cid,
      prevDeviceRecordCid: e0.recordCid,
    });
    const commit = (
      e: { recordCid: string; body: Uint8Array; proof: typeof fx.proof },
      seq: number,
    ) =>
      srv.commitRecord({
        recordCid: e.recordCid,
        roomId: ROOM,
        authorDeviceKeyId: DEVICE_KEY,
        deviceSeq: seq,
        capabilityCid: cap.cid,
        body: e.body,
        proofs: [e.proof],
      });
    expect((await commit(e0, 0)).status.status).toBe('accepted');
    expect((await commit(e1, 1)).status.status).toBe('accepted');
    expect(await srv.roomSize(ROOM)).toBe(2);
  });

  it('charges referenced media against max_media_bytes and rejects an over-budget event (§18.3 step 9)', async () => {
    // A capability whose media budget is 200 bytes; the event/payload budgets stay roomy.
    const srv = await serverWith({ capability: false });
    const cap = await mintCapability(fx, {
      capabilityId: 'cap-media',
      quotas: { max_media_bytes: 200 },
    });
    await srv.registerCapability(cap.bundle);

    // e0 references a 150-byte media block — the server stores it + links the block edge (as
    // the §29.3 pack-ingest path does from the contribution's body/table deps).
    const e0 = await mintContribution(fx, { deviceSeq: 0, capabilityCid: cap.cid });
    const b0 = new Uint8Array(150);
    const b0Cid = await cidFor('block', b0);
    await srv.putObject(b0Cid, 'block', b0);
    await srv.indexRecordEdge(e0.recordCid, b0Cid, 'block');
    const r0 = await srv.commitRecord({
      recordCid: e0.recordCid,
      roomId: ROOM,
      authorDeviceKeyId: DEVICE_KEY,
      deviceSeq: 0,
      capabilityCid: cap.cid,
      body: e0.body,
      proofs: [e0.proof],
    });
    // 150 ≤ 200 → accepted, debiting 150 of the media budget.
    expect(r0.status.status).toBe('accepted');

    // e1 references a 100-byte block — 150 + 100 = 250 > 200 → rejected_quota, never appended.
    const e1 = await mintContribution(fx, {
      deviceSeq: 1,
      capabilityCid: cap.cid,
      prevDeviceRecordCid: e0.recordCid,
    });
    const b1 = new Uint8Array(100);
    const b1Cid = await cidFor('block', b1);
    await srv.putObject(b1Cid, 'block', b1);
    await srv.indexRecordEdge(e1.recordCid, b1Cid, 'block');
    const r1 = await srv.commitRecord({
      recordCid: e1.recordCid,
      roomId: ROOM,
      authorDeviceKeyId: DEVICE_KEY,
      deviceSeq: 1,
      capabilityCid: cap.cid,
      body: e1.body,
      proofs: [e1.proof],
    });
    expect(r1.status.status).toBe('rejected_quota');
    expect(r1.receiptType).toBe('rejected');
    expect(await srv.isAccepted(e1.recordCid)).toBe(false);
    expect(await srv.roomSize(ROOM)).toBe(1);
  });

  it('does not charge media for a text-only contribution (no referenced blocks)', async () => {
    // A capability that allows NO media at all still accepts a text-only event (0 ≤ 0): the
    // media budget is only consumed by referenced media blocks, never by the signed event body.
    const srv = await serverWith({ capability: false });
    const cap = await mintCapability(fx, {
      capabilityId: 'cap-text-only',
      quotas: { max_media_bytes: 0 },
    });
    await srv.registerCapability(cap.bundle);
    const e0 = await mintContribution(fx, { deviceSeq: 0, capabilityCid: cap.cid });
    const r0 = await srv.commitRecord({
      recordCid: e0.recordCid,
      roomId: ROOM,
      authorDeviceKeyId: DEVICE_KEY,
      deviceSeq: 0,
      capabilityCid: cap.cid,
      body: e0.body,
      proofs: [e0.proof],
    });
    expect(r0.status.status).toBe('accepted');
  });
});

describe('LcapIngestServer.indexBodyBlockEdges (§27.1 signed-body reference cap)', () => {
  const enc = new TextEncoder();

  it('indexes block-kind body references within the cap and ignores non-block refs', async () => {
    const store = new InMemoryLcapServerStore();
    const srv = new LcapIngestServer(NET, () => NOW, store);
    const [b1, b2, recRef] = await Promise.all([
      cidFor('block', enc.encode('b1')),
      cidFor('block', enc.encode('b2')),
      cidFor('record', enc.encode('not-a-block')), // a record CID → must be ignored
    ]);
    expect(
      await srv.indexBodyBlockEdges('lcapr_rec1', {
        bodyBlockCid: b1,
        sourceSnapshotCids: [b2, recRef],
      }),
    ).toBe(true);
    expect((await store.recordEdges('lcapr_rec1', 'block')).slice().sort()).toEqual(
      [b1, b2].sort(),
    );
  });

  it('rejects (false) and indexes NOTHING when the declared count exceeds maxFanOut (§27 DoS bound)', async () => {
    const store = new InMemoryLcapServerStore();
    const srv = new LcapIngestServer(NET, () => NOW, store); // SERVER_CAPS.maxFanOut = 64
    const many = await Promise.all(
      Array.from({ length: 65 }, (_, i) => cidFor('block', enc.encode(`m${i}`))),
    );
    expect(await srv.indexBodyBlockEdges('lcapr_rec2', { sourceSnapshotCids: many })).toBe(false);
    // The unbounded index-write loop never ran: not one edge was written.
    expect(await store.recordEdges('lcapr_rec2', 'block')).toEqual([]);
  });

  it('rejects a very large source_snapshot_cids in O(1) without throwing (no huge spread)', async () => {
    const store = new InMemoryLcapServerStore();
    const srv = new LcapIngestServer(NET, () => NOW, store);
    // 200k elements — far beyond any JS spread/argument limit; the `.length` bound must reject
    // it WITHOUT materializing or spreading it (a spread would throw, turning a clean reject
    // into a 500).
    const huge = new Array<string>(200_000).fill('lcapb_x');
    expect(await srv.indexBodyBlockEdges('lcapr_huge', { sourceSnapshotCids: huge })).toBe(false);
    expect(await store.recordEdges('lcapr_huge', 'block')).toEqual([]);
  });
});

describe('LcapIngestServer.newImportBudget (§27.1 import CPU-time bound)', () => {
  it('reports over-budget once the clock passes the maxCpuTimeMsPerImportBatch cap', () => {
    let t = 1000;
    const srv = new LcapIngestServer(NET, () => t); // SERVER_CAPS cap = 5000ms
    const overBudget = srv.newImportBudget(); // startMs = 1000
    expect(overBudget()).toBe(false); // elapsed 0
    t = 1000 + 4000; // 4s ≤ 5s — still within budget
    expect(overBudget()).toBe(false);
    t = 1000 + 6000; // 6s > the 5s import-CPU cap — over budget
    expect(overBudget()).toBe(true);
  });
});
