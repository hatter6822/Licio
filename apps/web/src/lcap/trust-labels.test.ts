// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.1 — the §34 honest-label mapping: every trust × liveness state maps to one
// of the 13 honest labels; hard verdicts (rejected/revoked/conflict) cap any
// propagation claim; an authorized record is labeled by its furthest honest reach;
// and no single label collapses distinct states.

import { describe, expect, it } from 'vitest';
import {
  honestTrustLabel,
  type LcapLivenessState,
  type LcapTrustState,
  TRUST_LABEL_KEYS,
  TRUST_LABEL_TONE,
} from './trust-labels.js';

const TRUST_STATES: readonly LcapTrustState[] = [
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

const LIVENESS_STATES: readonly LcapLivenessState[] = [
  'local_created',
  'local_signed',
  'queued',
  'packed',
  'exported',
  'peer_stored',
  'relay_stored',
  'server_stored',
  'server_accepted',
  'checkpointed',
  'witnessed',
];

describe('honestTrustLabel — completeness', () => {
  it('maps every (trust × liveness) pair to a known label + tone', () => {
    for (const trust of TRUST_STATES) {
      for (const liveness of LIVENESS_STATES) {
        const label = honestTrustLabel(trust, liveness);
        expect(TRUST_LABEL_KEYS).toContain(label.key);
        expect(label.tone).toBe(TRUST_LABEL_TONE[label.key]);
      }
    }
  });

  it('exposes all 13 honest labels with no duplicates', () => {
    expect(TRUST_LABEL_KEYS).toHaveLength(13);
    expect(new Set(TRUST_LABEL_KEYS).size).toBe(13);
  });
});

describe('honestTrustLabel — hard verdicts cap propagation', () => {
  it('shows rejected/revoked/conflict regardless of how far liveness reached', () => {
    for (const liveness of LIVENESS_STATES) {
      expect(honestTrustLabel('rejected', liveness).key).toBe('rejected_by_room');
      expect(honestTrustLabel('revoked', liveness).key).toBe('revoked');
      expect(honestTrustLabel('conflicting', liveness).key).toBe('conflict_detected');
    }
    expect(honestTrustLabel('rejected', 'witnessed').tone).toBe('danger');
  });

  it('shows "cannot verify" for integrity-only trust + "stale" for stale-authorized', () => {
    expect(honestTrustLabel('raw_unverified', 'server_accepted').key).toBe(
      'cannot_verify_missing_key',
    );
    expect(honestTrustLabel('integrity_verified', 'checkpointed').key).toBe(
      'cannot_verify_missing_key',
    );
    expect(honestTrustLabel('stale_authorized', 'witnessed').key).toBe(
      'verified_local_stale_checkpoint',
    );
    expect(honestTrustLabel('integrity_verified', 'local_created').tone).toBe('caution');
  });
});

describe('honestTrustLabel — furthest honest reach for a positive record', () => {
  it('labels an authorized record by its propagation, from local up to witnessed', () => {
    const t = 'authorized_provisional';
    expect(honestTrustLabel(t, 'local_created').key).toBe('saved_on_device');
    expect(honestTrustLabel(t, 'queued').key).toBe('queued_for_sync');
    expect(honestTrustLabel(t, 'exported').key).toBe('shared_in_export');
    expect(honestTrustLabel(t, 'relay_stored').key).toBe('stored_by_relay');
    expect(honestTrustLabel(t, 'server_stored').key).toBe('received_by_server');
    expect(honestTrustLabel(t, 'server_accepted').key).toBe('accepted_by_room');
    expect(honestTrustLabel(t, 'checkpointed').key).toBe('included_in_checkpoint');
    expect(honestTrustLabel(t, 'witnessed').key).toBe('witnessed_by_watcher');
  });

  it('takes the furthest of trust OR liveness (trust ahead of liveness still counts)', () => {
    // The server-side trust state can be ahead of the locally-observed liveness.
    expect(honestTrustLabel('checkpointed', 'local_created').key).toBe('included_in_checkpoint');
    expect(honestTrustLabel('witnessed', 'queued').key).toBe('witnessed_by_watcher');
  });

  it('treats proof_verified-but-only-local as saved on device (no overclaim)', () => {
    expect(honestTrustLabel('proof_verified', 'local_signed').key).toBe('saved_on_device');
    expect(honestTrustLabel('proof_verified', 'local_signed').tone).toBe('neutral');
  });
});

describe('honestTrustLabel — no collapse', () => {
  it('uses distinct labels across the propagation ladder (never one "verified" badge)', () => {
    const t = 'authorized_provisional';
    const keys = (
      ['queued', 'server_stored', 'server_accepted', 'checkpointed', 'witnessed'] as const
    ).map((l) => honestTrustLabel(t, l).key);
    expect(new Set(keys).size).toBe(keys.length); // all distinct
  });
});
