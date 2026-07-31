// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.13 — conflict-table dispatch (§25.1) and the deterministic visible-thread
// projection (§25.2) with trust + safety overlays.

import { describe, expect, it } from 'vitest';
import { dispatchConflict, projectVisibleThread } from '../conflict/index.js';
import type { ThreadRecord } from '../records/projection.js';
import type { ContributionEventRecordV2 } from '../schemas/records.js';
import type { TrustState } from '../validate/states.js';
import type { ValidationResult } from '../validate/validate.js';

function result(
  over: Partial<ValidationResult> & { state: ValidationResult['state'] },
): ValidationResult {
  return { missingCids: [], facts: {}, ...over };
}

describe('conflict-table dispatch (WS-R.13.1)', () => {
  it('routes each conflict class to the §25.1 outcome', () => {
    expect(
      dispatchConflict({
        validation: result({ state: 'rejected', rejection: 'rejected_bad_cid' }),
      }),
    ).toMatchObject({ action: 'reject', status: 'rejected_bad_cid' });
    expect(
      dispatchConflict({
        validation: result({ state: 'rejected', rejection: 'rejected_bad_schema' }),
      }),
    ).toMatchObject({ action: 'reject' });
    // A bad signature is kept only as untrusted forensic material.
    expect(
      dispatchConflict({
        validation: result({ state: 'rejected', rejection: 'rejected_bad_signature' }),
      }),
    ).toMatchObject({ action: 'reject', keepForensic: true });
    // Missing dependency → quarantine (retriable).
    expect(
      dispatchConflict({
        validation: result({ state: 'proof_verified', missingCids: ['lcapr_cap'] }),
      }),
    ).toMatchObject({
      action: 'quarantine',
      status: 'quarantined_missing_dependency',
      missingCids: ['lcapr_cap'],
    });
    expect(
      dispatchConflict({
        validation: result({ state: 'revoked', revoked: { kind: 'device', id: 'k' } }),
      }),
    ).toMatchObject({ action: 'revoked', status: 'rejected_revoked' });
    // Forks always gossip evidence.
    expect(
      dispatchConflict({
        validation: result({ state: 'authorized_provisional' }),
        deviceForkDetected: true,
      }),
    ).toMatchObject({ action: 'conflicting', gossipForkEvidence: true });
    expect(
      dispatchConflict({
        validation: result({ state: 'authorized_provisional' }),
        checkpointForkDetected: true,
      }),
    ).toMatchObject({ action: 'conflicting', gossipForkEvidence: true, severe: true });
    // Expired capability follows room policy.
    expect(
      dispatchConflict({
        validation: result({ state: 'rejected', rejection: 'rejected_capability_expired' }),
        capabilityExpiredPolicy: 'quarantine',
      }),
    ).toMatchObject({ action: 'quarantine' });
    // A clean validation accepts.
    expect(
      dispatchConflict({ validation: result({ state: 'authorized_provisional' }) }),
    ).toMatchObject({ action: 'accept' });
  });

  it('never silently discards (every situation yields an outcome)', () => {
    const states: ValidationResult['state'][] = [
      'raw_unverified',
      'integrity_verified',
      'proof_verified',
      'authorized_provisional',
      'stale_authorized',
      'server_stored',
      'server_accepted',
      'checkpointed',
      'witnessed',
      'conflicting',
      'revoked',
      'rejected',
    ];
    for (const state of states) {
      const outcome = dispatchConflict({ validation: result({ state }) });
      expect(outcome.action).toBeDefined();
      expect(outcome.status).toBeDefined();
    }
  });
});

function record(
  over: Partial<ContributionEventRecordV2> & {
    event_type: ContributionEventRecordV2['event_type'];
  },
): ContributionEventRecordV2 {
  return {
    record_version: 2,
    kind: 'contribution_event',
    home_room_id: 'room-1',
    visibility_scope: 'public',
    author_account_id: 'a',
    author_device_id: 'd',
    author_device_key_id: 'k',
    device_seq: 0,
    capability_cid: 'cap',
    policy_epoch_claim: 0,
    revocation_epoch_claim: 0,
    client_nonce: new Uint8Array([0]),
    priority: 1,
    ...over,
  };
}

describe('visible-thread projection (WS-R.13.2)', () => {
  const records: ThreadRecord[] = [
    { recordCid: 'r-a', record: record({ event_type: 'post', device_seq: 0 }) },
    {
      recordCid: 'r-b',
      record: record({ event_type: 'answer', device_seq: 1, parent_record_cids: ['r-a'] }),
    },
  ];
  const trust: Record<string, TrustState> = { 'r-a': 'witnessed', 'r-b': 'proof_verified' };
  const opts = { trustOf: (cid: string) => trust[cid] ?? 'raw_unverified' };

  it('overlays trust and is deterministic across runs', () => {
    const a = projectVisibleThread(records, opts).contributions;
    const b = projectVisibleThread([...records].reverse(), opts).contributions;
    expect(a.map((c) => c.visibleCid + c.trustState)).toEqual(
      b.map((c) => c.visibleCid + c.trustState),
    );
    expect(a.find((c) => c.rootCid === 'r-a')?.trustState).toBe('witnessed');
  });

  it('flags a conflict touching a SUPERSEDED edit, not just the visible chain', () => {
    // Two authorized edits fork the record; `pickLatestEdit` picks one and §25.1
    // retains the loser in `supersededEdits`.  This mapper tested only the visible
    // `editChain`, so a device/checkpoint conflict naming the loser left the
    // contribution `conflicting: false` — the overlay declining to flag exactly the
    // evidence the projection kept for it.
    const base: ThreadRecord = {
      recordCid: 'c-post',
      record: record({ event_type: 'post', device_seq: 0 }),
    };
    const branchA: ThreadRecord = {
      recordCid: 'c-a',
      record: record({ event_type: 'edit', device_seq: 1, replaces_record_cid: 'c-post' }),
    };
    const branchB: ThreadRecord = {
      recordCid: 'c-b',
      record: record({
        event_type: 'edit',
        author_device_key_id: 'k2',
        device_seq: 1,
        replaces_record_cid: 'c-post',
      }),
    };
    const all = [base, branchA, branchB];
    const visible = projectVisibleThread(all, opts).contributions[0]?.visibleCid;
    const loser = visible === 'c-a' ? 'c-b' : 'c-a';
    // The loser is retained but NOT on the visible chain…
    const projection = projectVisibleThread(all, opts).contributions[0];
    expect(projection?.supersededEdits).toEqual([loser]);
    expect(projection?.editChain).not.toContain(loser);
    // …and a conflict naming it flags the contribution.
    const flagged = projectVisibleThread(all, {
      ...opts,
      conflictingCids: new Set([loser]),
    }).contributions[0];
    expect(flagged?.conflicting).toBe(true);
  });

  it('carries unresolved refusal evidence through the trust/safety overlay', () => {
    // The overlay layer's own header promises conflicting evidence "remains
    // INSPECTABLE (flagged, never dropped)".  It maps the projection's
    // contributions, so returning only those would have re-broken the §25.2
    // guarantee ONE LAYER ABOVE the fix that closed it — and every other test here
    // reads `.contributions`, so nothing would have noticed.
    const orphan: ThreadRecord = {
      recordCid: 'r-orphan',
      record: record({
        event_type: 'edit',
        author_account_id: 'attacker',
        author_device_key_id: 'attacker-key',
        replaces_record_cid: 'never-synced',
      }),
    };
    const projection = projectVisibleThread([...records, orphan], opts);
    expect(projection.contributions).toHaveLength(2);
    expect(projection.unresolvedSupersedes).toEqual([
      { targetCid: 'never-synced', recordCids: ['r-orphan'] },
    ]);
  });

  it('restricts low-trust content in strict safety mode but keeps it inspectable', () => {
    const strict = projectVisibleThread(records, { ...opts, safetyMode: 'strict' }).contributions;
    const low = strict.find((c) => c.rootCid === 'r-b');
    expect(low?.restrictedBySafety).toBe(true); // proof_verified is below authorized
    expect(low?.shownByDefault).toBe(false);
    // Still present in the projection — never silently deleted.
    expect(strict).toHaveLength(2);
    const high = strict.find((c) => c.rootCid === 'r-a');
    expect(high?.shownByDefault).toBe(true); // witnessed is shown even in strict mode
  });

  it('flags conflicting evidence without dropping it', () => {
    const conflicted = projectVisibleThread(records, {
      ...opts,
      conflictingCids: new Set(['r-b']),
    }).contributions;
    expect(conflicted.find((c) => c.rootCid === 'r-b')?.conflicting).toBe(true);
    expect(conflicted).toHaveLength(2);
  });
});
