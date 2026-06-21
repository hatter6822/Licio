// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.10 — liveness states + targets, receipts (issuer auth ≠ content trust),
// and the durable-outbox pin classification + retry scheduling.

import { describe, expect, it } from 'vitest';
import { cidFor } from '../cid/index.js';
import { generateDeviceKey } from '../cose/keys.js';
import {
  dueForRetry,
  isHardPinned,
  LIVENESS_TARGET,
  LivenessTracker,
  livenessFromReceipt,
  livenessTargetMet,
  type OutboxEntry,
  type PinClass,
  scheduleRetry,
  signReceipt,
  survivesEviction,
  verifyReceipt,
} from '../liveness/index.js';

describe('liveness state machine (WS-R.10.1)', () => {
  it('advances monotonically and records first-reached timestamps', () => {
    const tracker = new LivenessTracker(100);
    expect(tracker.current).toBe('local_created');
    tracker.observe('local_signed', 200);
    tracker.observe('queued', 300);
    tracker.observe('server_stored', 500);
    expect(tracker.current).toBe('server_stored');
    // A lower-rank observation never moves the current state backward.
    tracker.observe('packed', 600);
    expect(tracker.current).toBe('server_stored');
    expect(tracker.has('queued')).toBe(true);
    expect(tracker.firstReachedAt('queued')).toBe(300);
    // Idempotent: re-observing keeps the earliest timestamp.
    tracker.observe('queued', 999);
    expect(tracker.firstReachedAt('queued')).toBe(300);
  });

  it('evaluates the §20.3 replication targets per class', () => {
    expect(LIVENESS_TARGET.P0).toBe(8);
    expect(livenessTargetMet('P1', 3)).toBe(true);
    expect(livenessTargetMet('P1', 2)).toBe(false);
    expect(livenessTargetMet('P4', 0)).toBe(true); // no target
  });
});

describe('receipts (WS-R.10.2)', () => {
  it('authenticates the issuer only — a receipt is not content truth', async () => {
    const issuer = await generateDeviceKey();
    const subject = await cidFor('record', new Uint8Array([1]));
    const bundle = await signReceipt({
      issuerPrivateKey: issuer.privateKey,
      issuerSignerKeyId: 'server-node-1',
      receipt: {
        record_version: 2,
        kind: 'receipt',
        receipt_type: 'stored',
        issuer_node_id: 'server-node-1',
        subject_cids: [subject],
      },
      networkId: 'prod',
    });
    const verified = await verifyReceipt(bundle, issuer.publicKey, { networkId: 'prod' });
    expect(verified).toEqual({ ok: true, issuerKeyId: 'server-node-1' });
    // The result identifies the issuer; it confers NO content trust.
    expect(Object.keys(verified)).toEqual(['ok', 'issuerKeyId']);
    const forged = await generateDeviceKey();
    expect((await verifyReceipt(bundle, forged.publicKey, { networkId: 'prod' })).ok).toBe(false);
  });

  it('maps receipt types to liveness advances', () => {
    expect(livenessFromReceipt('stored', 'peer')).toBe('peer_stored');
    expect(livenessFromReceipt('stored', 'relay')).toBe('relay_stored');
    expect(livenessFromReceipt('stored', 'server')).toBe('server_stored');
    expect(livenessFromReceipt('accepted', 'server')).toBe('server_accepted');
    expect(livenessFromReceipt('checkpointed', 'server')).toBe('checkpointed');
    expect(livenessFromReceipt('rejected', 'server')).toBeUndefined(); // no advance
  });
});

describe('durable outbox (WS-R.10.3)', () => {
  it('hard-pins outbox material and evicts only ambient cache', () => {
    const classes: PinClass[] = [
      'draft',
      'outbox_record',
      'required_proof',
      'body_block',
      'export_history',
      'receipt',
      'ambient_cache',
    ];
    for (const pinClass of classes) {
      expect(isHardPinned(pinClass)).toBe(pinClass !== 'ambient_cache');
    }
    const entries = classes.map((pinClass) => ({ pinClass, cid: pinClass }));
    const survivors = survivesEviction(entries);
    expect(survivors.map((e) => e.pinClass)).not.toContain('ambient_cache');
    expect(survivors).toHaveLength(6);
  });

  it('schedules exponential retry backoff and finds due entries', () => {
    let entry: OutboxEntry = { cid: 'lcapr_x', attempts: 0 };
    entry = scheduleRetry(entry, 1000, { baseMs: 100, maxMs: 10_000 });
    expect(entry).toMatchObject({ attempts: 1, nextRetryMs: 1100 });
    entry = scheduleRetry(entry, 2000, { baseMs: 100, maxMs: 10_000 });
    expect(entry).toMatchObject({ attempts: 2, nextRetryMs: 2200 }); // 100 × 2^1
    entry = scheduleRetry(entry, 3000, { baseMs: 100, maxMs: 10_000 });
    expect(entry.nextRetryMs).toBe(3400); // 100 × 2^2
    expect(dueForRetry([entry], 3300)).toHaveLength(0);
    expect(dueForRetry([entry], 3400)).toHaveLength(1);
  });
});
