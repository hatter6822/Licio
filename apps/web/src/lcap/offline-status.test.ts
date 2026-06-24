// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.3 — the content-free local offline-state summary: it derives the honest §20
// outbox posture (queued / retrying / exported) and §25 conflict presence from the REAL
// `lcap_v2` stores, never throwing on a missing DB or unexpected row.

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { getLcapDb, LCAP_STORE, resetLcapDbConnection } from './db.js';
import { readOfflineStatus } from './offline-status.js';

async function put(store: string, value: unknown): Promise<void> {
  const db = await getLcapDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

describe('readOfflineStatus (§20 / §25)', () => {
  afterEach(() => {
    resetLcapDbConnection();
    indexedDB.deleteDatabase('lcap_v2');
  });

  it('returns the empty summary when the stores are empty', async () => {
    const summary = await readOfflineStatus();
    expect(summary.outbox).toEqual({ queued: 0, retrying: 0, exported: 0 });
    expect(summary.hasConflict).toBe(false);
  });

  it('classifies outbox rows into the honest §20 states and tracks the retry attempt', async () => {
    await put(LCAP_STORE.outbox, { recordCid: 'r1', status: 'queued', retries: 0 });
    await put(LCAP_STORE.outbox, { recordCid: 'r2', status: 'retrying', retries: 3 });
    await put(LCAP_STORE.outbox, { recordCid: 'r3', status: 'exported', retries: 0 });
    await put(LCAP_STORE.outbox, { recordCid: 'r4', status: 'sent', retries: 0 }); // propagated → not surfaced
    const summary = await readOfflineStatus();
    expect(summary.outbox).toEqual({ queued: 1, retrying: 1, exported: 1 });
    expect(summary.maxRetryAttempt).toBe(3);
  });

  it('treats a queued row with retries as retrying', async () => {
    await put(LCAP_STORE.outbox, { recordCid: 'r1', status: 'queued', retries: 2 });
    const summary = await readOfflineStatus();
    expect(summary.outbox.retrying).toBe(1);
    expect(summary.outbox.queued).toBe(0);
  });

  it('reports a §25 conflict when fork evidence is quarantined', async () => {
    await put(LCAP_STORE.quarantine, { cid: 'c1', reason: 'device_fork', firstSeen: 1 });
    const summary = await readOfflineStatus();
    expect(summary.hasConflict).toBe(true);
  });

  it('ignores rows that fail validation without throwing', async () => {
    await put(LCAP_STORE.outbox, { recordCid: 'r1', status: 'queued' });
    await put(LCAP_STORE.outbox, { recordCid: 'bad', status: 12345 });
    const summary = await readOfflineStatus();
    expect(summary.outbox.queued).toBe(1);
  });
});
