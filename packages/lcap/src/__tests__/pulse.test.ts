// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sync pulse build/apply (§16.1, §16.2, WS-R.6.1): the pulse carries only
// frontier/critical material, is fail-closed-validated, and diffs against local
// frontiers to yield the right wants/offers — so a session dying after the pulse
// has still moved trust/liveness data.

import { beforeAll, describe, expect, it } from 'vitest';
import { cidFor } from '../cid/index.js';
import {
  type ExchangeBudgetV2,
  exchangeBudgetV2Schema,
  pulseResponseV2Schema,
  syncPulseV2Schema,
} from '../schemas/index.js';
import { applyPulse, buildPulse, buildPulseResponse, type PulseInputs } from '../sync/index.js';

const enc = new TextEncoder();

const budget: ExchangeBudgetV2 = {
  max_request_bytes: 65536,
  max_response_bytes: 262144,
  max_pack_table_entries: 256,
  max_frame_bytes: 65536,
  max_uncompressed_bytes: 1048576,
  max_records: 256,
  max_proofs: 256,
  max_blocks: 64,
  priority_floor: 4,
  allow_evidence: true,
  allow_media: true,
  allow_private_encrypted: false,
};

const roomA = new Uint8Array([0xaa]);
let ckptCid: string;
let revCid: string;
let criticalCid: string;

beforeAll(async () => {
  ckptCid = await cidFor('record', enc.encode('checkpoint-A'));
  revCid = await cidFor('record', enc.encode('revocation-global'));
  criticalCid = await cidFor('record', enc.encode('critical-1'));
});

function inputs(over: Partial<PulseInputs> = {}): PulseInputs {
  return {
    nodeId: 'node-1',
    sessionNonce: new Uint8Array([1, 2, 3]),
    transportProfile: 'https',
    privacyMode: 'public',
    budgets: budget,
    supportedSuites: ['ES256'],
    supportedCompression: ['gzip'],
    supportedPackVersions: [2],
    checkpointFrontier: [],
    revocationFrontier: [],
    ...over,
  };
}

describe('buildPulse (§16.2)', () => {
  it('builds a schema-valid pulse and omits absent optionals', () => {
    const pulse = buildPulse(inputs());
    expect(() => syncPulseV2Schema.parse(pulse)).not.toThrow();
    expect('capability_frontier' in pulse).toBe(false);
    expect('critical_have' in pulse).toBe(false);
    expect('lane_summary' in pulse).toBe(false);
  });

  it('includes optionals when provided', () => {
    const pulse = buildPulse(inputs({ criticalHave: [criticalCid] }));
    expect(pulse.critical_have).toEqual([criticalCid]);
  });

  it('fails closed on an invalid input (empty node id)', () => {
    expect(() => buildPulse(inputs({ nodeId: '' }))).toThrow();
  });

  it('builds a large (>2048-room) frontier without throwing (frontiers are not element-capped)', () => {
    // A node tracking many rooms emits one checkpoint-frontier entry per room.  The frontier must
    // NOT be element-capped in the shared schema, or such a node's own `buildPulse` would throw
    // (the server hosts ALL rooms) — the frontier fan-out is bounded at the route layer instead.
    const many = Array.from({ length: 3000 }, (_, i) => ({
      room_id_hash: new Uint8Array([i & 0xff, (i >> 8) & 0xff]),
      latest_tree_size: i,
    }));
    const pulse = buildPulse(inputs({ checkpointFrontier: many }));
    expect(() => syncPulseV2Schema.parse(pulse)).not.toThrow();
    expect(pulse.checkpoint_frontier).toHaveLength(3000);
  });
});

describe('applyPulse (§16.2 frontier diff)', () => {
  it('wants the remote checkpoint when we are behind', () => {
    const remote = buildPulse(
      inputs({
        checkpointFrontier: [
          { room_id_hash: roomA, latest_checkpoint_cid: ckptCid, latest_tree_size: 9 },
        ],
      }),
    );
    const reaction = applyPulse({
      remote,
      localCheckpointFrontier: [{ room_id_hash: roomA, latest_tree_size: 3 }],
      localRevocationFrontier: [],
      locallyHave: () => false,
    });
    expect(reaction.wants).toContainEqual({
      cid: ckptCid,
      cid_kind: 'record',
      reason: 'checkpoint_gap',
    });
  });

  it('wants revocations first when behind', () => {
    const remote = buildPulse(
      inputs({
        revocationFrontier: [
          { scope: 'global', revocation_epoch: 7, latest_revocation_checkpoint_cid: revCid },
        ],
      }),
    );
    const reaction = applyPulse({
      remote,
      localCheckpointFrontier: [],
      localRevocationFrontier: [{ scope: 'global', revocation_epoch: 2 }],
      locallyHave: () => false,
    });
    expect(reaction.wants[0]).toEqual({
      cid: revCid,
      cid_kind: 'record',
      reason: 'revocation_gap',
    });
    expect(reaction.remoteBehindRevocation).toBe(false);
  });

  it('flags remoteBehindRevocation when we are ahead (§17.3)', () => {
    const remote = buildPulse(
      inputs({ revocationFrontier: [{ scope: 'global', revocation_epoch: 1 }] }),
    );
    const reaction = applyPulse({
      remote,
      localCheckpointFrontier: [],
      localRevocationFrontier: [{ scope: 'global', revocation_epoch: 5 }],
      locallyHave: () => false,
    });
    expect(reaction.remoteBehindRevocation).toBe(true);
  });

  it('wants critical_have we lack and offers critical_want we hold', () => {
    const remote = buildPulse(inputs({ criticalHave: [criticalCid], criticalWant: [ckptCid] }));
    const reaction = applyPulse({
      remote,
      localCheckpointFrontier: [],
      localRevocationFrontier: [],
      locallyHave: (cid) => cid === ckptCid,
    });
    expect(reaction.wants).toContainEqual({
      cid: criticalCid,
      cid_kind: 'record',
      reason: 'missing_dependency',
    });
    expect(reaction.offerToRemote).toEqual([ckptCid]);
  });

  it('never wants an object we already have (dedup + locallyHave)', () => {
    const remote = buildPulse(
      inputs({
        checkpointFrontier: [
          { room_id_hash: roomA, latest_checkpoint_cid: ckptCid, latest_tree_size: 9 },
        ],
        criticalHave: [ckptCid],
      }),
    );
    const reaction = applyPulse({
      remote,
      localCheckpointFrontier: [],
      localRevocationFrontier: [],
      locallyHave: (cid) => cid === ckptCid,
    });
    expect(reaction.wants.find((w) => w.cid === ckptCid)).toBeUndefined();
  });

  it('truncated-after-pulse still advances trust knowledge first', () => {
    // The pulse alone (no pack) yields the frontier-derived wants, revocations
    // before checkpoints — trust/liveness moves before any content.
    const remote = buildPulse(
      inputs({
        revocationFrontier: [
          { scope: 'global', revocation_epoch: 9, latest_revocation_checkpoint_cid: revCid },
        ],
        checkpointFrontier: [
          { room_id_hash: roomA, latest_checkpoint_cid: ckptCid, latest_tree_size: 4 },
        ],
      }),
    );
    const reaction = applyPulse({
      remote,
      localCheckpointFrontier: [],
      localRevocationFrontier: [],
      locallyHave: () => false,
    });
    expect(reaction.wants.map((w) => w.reason)).toEqual(['revocation_gap', 'checkpoint_gap']);
  });
});

describe('buildPulseResponse (§29.1)', () => {
  it('wraps the pulse and omits absent optionals', () => {
    const response = buildPulseResponse({ pulse: buildPulse(inputs()) });
    expect(() => pulseResponseV2Schema.parse(response)).not.toThrow();
    expect('critical_pack' in response).toBe(false);
    expect('retry_after_ms' in response).toBe(false);
  });

  it('carries an inline critical pack + retry hint when provided', () => {
    const pack = new Uint8Array([9, 9, 9]);
    const response = buildPulseResponse({
      pulse: buildPulse(inputs()),
      criticalPack: pack,
      retryAfterMs: 1500,
    });
    expect(response.critical_pack).toEqual(pack);
    expect(response.retry_after_ms).toBe(1500);
  });

  it('fails closed on an invalid embedded pulse', () => {
    const badPulse = { ...buildPulse(inputs()), node_id: '' };
    expect(() => buildPulseResponse({ pulse: badPulse })).toThrow();
  });
});

describe('sync schemas are strict (§9.1.4)', () => {
  it('rejects an unknown key on the pulse', () => {
    const pulse = buildPulse(inputs());
    expect(() => syncPulseV2Schema.parse({ ...pulse, rogue: 1 })).toThrow();
  });

  it('rejects a non-integer budget field', () => {
    expect(() => exchangeBudgetV2Schema.parse({ ...budget, max_records: 1.5 })).toThrow();
  });
});
