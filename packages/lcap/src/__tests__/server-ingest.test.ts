// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Server ingestion orchestrator (§24.1/§24.2/§24.5, WS-R.12.1c): the commit-stage
// decision over the shipped primitives — idempotency, the §25.1 conflict table,
// the room-log-append gate, receipts, and missing-dependency wants.  The §24.2
// "never emit before validation" rule is structural: only a freshly-accepted
// record appends to the room log.

import { beforeAll, describe, expect, it } from 'vitest';
import { cidFor } from '../cid/index.js';
import type { ConflictSituation } from '../conflict/index.js';
import { objectStatusV2Schema } from '../schemas/index.js';
import { ingestRecord } from '../sync/index.js';
import type { ValidationResult } from '../validate/index.js';

const vr = (
  state: ValidationResult['state'],
  over: Omit<ValidationResult, 'state' | 'missingCids' | 'facts'> & {
    missingCids?: readonly string[];
  } = {},
): ValidationResult => ({ state, missingCids: over.missingCids ?? [], facts: {}, ...over });

let missingCid: string;

beforeAll(async () => {
  missingCid = await cidFor('record', new TextEncoder().encode('dep-1'));
});

describe('ingestRecord (§24.1 commit-stage decision)', () => {
  it('short-circuits an idempotent re-submit to already_have without re-appending', () => {
    const out = ingestRecord({
      alreadyHave: true,
      situation: { validation: vr('authorized_provisional') },
    });
    expect(out.status).toBe('already_have');
    expect(out.appendToRoomLog).toBe(false);
    expect(out.issueReceipt).toBe('accepted');
  });

  it('accepts a clean record and appends to the room log', () => {
    const out = ingestRecord({
      alreadyHave: false,
      situation: { validation: vr('authorized_provisional') },
    });
    expect(out.status).toBe('accepted');
    expect(out.appendToRoomLog).toBe(true);
    expect(out.issueReceipt).toBe('accepted');
    expect(out.wants).toEqual([]);
  });

  it('quarantines a record with unmet dependencies and emits precise wants', () => {
    const out = ingestRecord({
      alreadyHave: false,
      situation: { validation: vr('proof_verified', { missingCids: [missingCid] }) },
    });
    expect(out.status).toBe('quarantined_missing_dependency');
    expect(out.appendToRoomLog).toBe(false);
    expect(out.issueReceipt).toBe('quarantined');
    expect(out.wants).toEqual([
      { cid: missingCid, cid_kind: 'record', reason: 'missing_dependency' },
    ]);
    expect(out.missingCids).toEqual([missingCid]);
  });

  it('drops identity-dependency pseudo-keys so the wire status/wants stay CID-clean', () => {
    // validate() reports a missing proof/cert/signer-key/authority-key as a DIAGNOSTIC
    // pseudo-key, not a content CID.  Those are invalid under `anyCidSchema`, so if they
    // reached the wire `missing_cids`/`want` the whole exchange-response parse would throw.
    // ingestRecord must surface only the well-formed CID(s); the pseudo-keys are dropped.
    const out = ingestRecord({
      alreadyHave: false,
      situation: {
        validation: vr('proof_verified', {
          missingCids: [
            `proof_for:${missingCid}`,
            'signer_key:dev-abc',
            'device_certificate:dev-abc',
            'account_authority_key:acct-1:0',
            'room_authority_key:room-1:0',
            missingCid, // the one genuinely fetchable CID
          ],
        }),
      },
    });
    expect(out.status).toBe('quarantined_missing_dependency');
    expect(out.missingCids).toEqual([missingCid]);
    expect(out.wants).toEqual([
      { cid: missingCid, cid_kind: 'record', reason: 'missing_dependency' },
    ]);
    // The wire projection must now parse: every `missing_cids` entry is a valid CID.
    expect(() =>
      objectStatusV2Schema.parse({
        cid: missingCid,
        cid_kind: 'record',
        status: out.status,
        missing_cids: out.missingCids,
      }),
    ).not.toThrow();
  });

  it('reports no fetchable CID when the missing dependency is purely an identity pseudo-key', () => {
    // A quarantine whose only unmet dependency is a missing signer key has nothing the peer
    // can fetch by CID — the honest wire answer is an empty `missing_cids`, never a throw.
    const out = ingestRecord({
      alreadyHave: false,
      situation: { validation: vr('proof_verified', { missingCids: ['signer_key:dev-xyz'] }) },
    });
    expect(out.status).toBe('quarantined_missing_dependency');
    expect(out.missingCids).toEqual([]);
    expect(out.wants).toEqual([]);
    expect(() =>
      objectStatusV2Schema.parse({ cid: missingCid, cid_kind: 'record', status: out.status }),
    ).not.toThrow();
  });

  it('keeps a bad-signature body as forensic, never appends, issues a rejected receipt', () => {
    const out = ingestRecord({
      alreadyHave: false,
      situation: { validation: vr('rejected', { rejection: 'rejected_bad_signature' }) },
    });
    expect(out.status).toBe('rejected_bad_signature');
    expect(out.appendToRoomLog).toBe(false);
    expect(out.keepForensic).toBe(true);
    expect(out.issueReceipt).toBe('rejected');
  });

  it('marks a revoked record rejected_revoked', () => {
    const out = ingestRecord({ alreadyHave: false, situation: { validation: vr('revoked') } });
    expect(out.status).toBe('rejected_revoked');
    expect(out.issueReceipt).toBe('rejected');
    expect(out.appendToRoomLog).toBe(false);
  });

  it('flags a device fork for gossip and never appends or receipts it', () => {
    const out = ingestRecord({
      alreadyHave: false,
      situation: { validation: vr('authorized_provisional'), deviceForkDetected: true },
    });
    expect(out.status).toBe('conflict_device_fork');
    expect(out.gossipForkEvidence).toBe(true);
    expect(out.appendToRoomLog).toBe(false);
    expect(out.issueReceipt).toBeUndefined();
  });

  it('never appends a non-accepted record to the room log (§24.2)', () => {
    const nonAccept: ConflictSituation[] = [
      { validation: vr('proof_verified', { missingCids: [missingCid] }) },
      { validation: vr('rejected', { rejection: 'rejected_bad_schema' }) },
      { validation: vr('revoked') },
      { validation: vr('authorized_provisional'), deviceForkDetected: true },
    ];
    for (const situation of nonAccept) {
      expect(ingestRecord({ alreadyHave: false, situation }).appendToRoomLog).toBe(false);
    }
  });
});
