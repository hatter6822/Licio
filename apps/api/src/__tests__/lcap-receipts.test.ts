// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.10.2 / WS-R.12.1c — SERVER-EMITTED signed receipts.  After ingestion the node
// (when it holds a receipt-signing key) issues signed `receipt` records grouped by
// outcome type, stamps each per-object status with its `receipt_cid`, and durably
// stores the receipt record + proof.  These tests prove the receipt VERIFIES against
// the issuer key, identifies its issuer, groups by type, and is a HINT — never content
// trust — and that the §29.3 pack-import returns them inline.

import {
  cidFor,
  decodeWithSchema,
  detachedProofV2Schema,
  generateDeviceKey,
  type ObjectStatusV2,
  receiptRecordV2Schema,
  verifyReceipt,
} from '@licio/lcap';
import { describe, expect, it } from 'vitest';
import { LcapIngestServer } from '../lcap/server-ingest.js';

const NET = 'prod';
const enc = new TextEncoder();

const status = (
  cid: string,
  s: ObjectStatusV2['status'],
  kind: ObjectStatusV2['cid_kind'] = 'record',
): ObjectStatusV2 => ({ cid, cid_kind: kind, status: s });

/** A real, schema-valid record CID for a label (the receipt schema validates every CID). */
const recCid = (label: string): Promise<string> => cidFor('record', enc.encode(label));
const blkCid = (label: string): Promise<string> => cidFor('block', enc.encode(label));

/** A server with a receipt-signing key configured + the node's public key for verification. */
async function issuingServer(): Promise<{ srv: LcapIngestServer; nodePublicKey: CryptoKey }> {
  const node = await generateDeviceKey();
  const srv = new LcapIngestServer(NET, () => 1_000_000);
  srv.configureReceiptIssuer(node.privateKey, 'node-key-1', 'lcap-server:test');
  return { srv, nodePublicKey: node.publicKey };
}

describe('LcapIngestServer — server-emitted signed receipts (WS-R.10.2 / 12.1c)', () => {
  it('issues a signed receipt over accepted records, stamps the status, stores record + proof', async () => {
    const { srv, nodePublicKey } = await issuingServer();
    const aCid = await recCid('a');
    const { statuses, receipts } = await srv.issueReceipts([status(aCid, 'accepted')]);

    expect(receipts).toHaveLength(1);
    const r = receipts[0];
    if (!r) return;
    expect(r.record.receipt_type).toBe('accepted');
    expect(r.record.issuer_node_id).toBe('lcap-server:test');
    expect(r.record.subject_cids).toEqual([aCid]);

    // The receipt's authority proof VERIFIES against the issuer node's public key (issuer
    // identified); its signer key id is the configured one.
    const proof = decodeWithSchema(detachedProofV2Schema, r.proofBody);
    const verified = await verifyReceipt(
      { receipt: r.record, body: r.recordBody, proof },
      nodePublicKey,
      {
        networkId: NET,
      },
    );
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.issuerKeyId).toBe('node-key-1');

    // The status is stamped with the receipt CID; the record + proof are durably stored.
    expect(statuses[0]?.receipt_cid).toBe(r.cid);
    expect(r.cid).toBe(await cidFor('record', r.recordBody));
    expect(await srv.hasObject(r.cid)).toBe(true);
    expect(await srv.hasObject(r.proofCid)).toBe(true);
  });

  it('groups a mixed batch into one receipt per outcome type', async () => {
    const { srv } = await issuingServer();
    const [a, b, c, d, e] = await Promise.all([
      recCid('a'),
      recCid('b'),
      recCid('c'),
      blkCid('d'),
      recCid('e'),
    ]);
    const { statuses, receipts } = await srv.issueReceipts([
      status(a, 'accepted'),
      status(b, 'accepted'),
      status(c, 'rejected_quota'),
      status(d, 'stored_unverified', 'block'),
      status(e, 'quarantined_missing_dependency'),
    ]);

    const byType = new Map(receipts.map((r) => [r.record.receipt_type, r]));
    expect([...byType.keys()].sort()).toEqual(['accepted', 'quarantined', 'rejected', 'stored']);
    expect(byType.get('accepted')?.record.subject_cids).toEqual([a, b]);
    expect(byType.get('rejected')?.record.subject_cids).toEqual([c]);
    // The fine status survives in status_detail (e.g. the exact rejection reason).
    expect(byType.get('rejected')?.record.status_detail?.[0]?.status).toBe('rejected_quota');
    // Every covered status is stamped with the right receipt CID.
    expect(statuses.find((s) => s.cid === c)?.receipt_cid).toBe(byType.get('rejected')?.cid);
    expect(statuses.find((s) => s.cid === d)?.receipt_cid).toBe(byType.get('stored')?.cid);
  });

  it('emits NO receipts (statuses unchanged) when the node has no receipt issuer', async () => {
    const srv = new LcapIngestServer(NET, () => 1_000_000); // no configureReceiptIssuer
    const input = [status('lcapr_a', 'accepted')];
    const { statuses, receipts } = await srv.issueReceipts(input);
    expect(receipts).toEqual([]);
    expect(statuses[0]?.receipt_cid).toBeUndefined();
  });

  it('the §29.3 POST /packs response carries inline signed receipts', async () => {
    // A bare block pack (no contribution): the block is `stored_unverified` → a `stored` receipt.
    const { writePack } = await import('@licio/lcap');
    const enc = new TextEncoder();
    const blockBytes = enc.encode('receipt-test-block');
    const blockCid = await cidFor('block', blockBytes);
    const pack = writePack({
      objects: [
        {
          cid: blockCid,
          cidKind: 'block',
          frameKind: 'block',
          payload: blockBytes,
          lane: 'B4',
          priority: 4,
        },
      ],
      transportProfile: 'manual_bundle',
      privacyLabel: 'public',
      maxUncompressedBytes: 1_000_000,
    });

    const { srv, nodePublicKey } = await issuingServer();
    const { createLcapRoutes } = await import('../lcap/routes.js');
    const res = await createLcapRoutes(srv).request('/packs', { method: 'POST', body: pack });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      statuses: { cid: string; receipt_cid?: string }[];
      receipts?: { cid: string; record_body: string; proof_cid: string; proof_body: string }[];
    };
    expect(data.receipts).toBeDefined();
    expect(data.receipts).toHaveLength(1);
    const wire = data.receipts?.[0];
    if (!wire) return;
    expect(data.statuses.find((s) => s.cid === blockCid)?.receipt_cid).toBe(wire.cid);

    // The inline receipt is a real signed record that verifies against the node key.
    const hexToBytes = (h: string) =>
      new Uint8Array((h.match(/.{2}/g) ?? []).map((x) => Number.parseInt(x, 16)));
    const recordBody = hexToBytes(wire.record_body);
    const receipt = decodeWithSchema(receiptRecordV2Schema, recordBody);
    expect(receipt.receipt_type).toBe('stored');
    const proof = decodeWithSchema(detachedProofV2Schema, hexToBytes(wire.proof_body));
    const verified = await verifyReceipt({ receipt, body: recordBody, proof }, nodePublicKey, {
      networkId: NET,
    });
    expect(verified.ok).toBe(true);
  });
});
