// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every store a unit HANDS OUT must be a store the unit can UNDO.
//
// The in-memory units take their rollback set as `[...stores].filter(s =>
// typeof s.beginRollback === 'function')`, which turns a missing guarantee into
// silence: a store that never declared `beginRollback` is simply absent from the
// undo, `transact` still resolves, and every test over it passes while the
// atomicity it advertises is not there. That is exactly what happened to WS-F —
// `IngestionServices.transact` shipped with FIVE stores on its tx and none of
// them in the rollback list, so a takedown that hid a story and then failed its
// audit append left the story hidden with the takedown rolled back.
//
// So the filter is checked rather than trusted: whatever a domain puts on its
// transaction surface, this suite asks the same question of it, and a new store
// added to a tx without an undo fails here instead of in production.
import { beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryComplianceServices } from '../compliance/services.js';
import { InMemoryPwattConfigStore } from '../events/stores.js';
import { createInMemoryForumServices } from '../forum/services.js';
import {
  createInMemoryIdentityServices,
  type IdentityServices,
  setIdentityServices,
} from '../identity/services.js';
import { createInMemoryIngestionServices } from '../ingestion/services.js';

const IDENTITY_CONFIG = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
  signupPow: { maxNumber: 16 },
} as const;

// The domain factories read the identity services from the module singleton
// (their tx surfaces carry the WS-D trail), so it is installed per test.
let identity: IdentityServices;

beforeEach(() => {
  identity = createInMemoryIdentityServices(IDENTITY_CONFIG);
  setIdentityServices(identity);
});

/** The rollback-bearing shape, checked the way the units' own filter checks. */
function undoable(value: unknown): boolean {
  return typeof (value as { beginRollback?: unknown } | null)?.beginRollback === 'function';
}

/**
 * Every STORE on a tx surface, by field name.
 *
 * A tx also carries bound FUNCTIONS (`tx.audit(input)` on WS-H) and read-only
 * projections; only object-valued fields are stores that can hold state, so
 * those are what the undo has to cover.
 */
function storeFields(tx: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(tx).filter(
    ([, value]) => typeof value === 'object' && value !== null && !Array.isArray(value),
  );
}

describe('a unit can undo everything it hands out', () => {
  it('WS-F ingestion — sources, syndications, takedowns, stories, embeddings, audit', async () => {
    const ingestion = createInMemoryIngestionServices();
    const missing: string[] = [];
    await ingestion.transact(async (tx) => {
      for (const [name, store] of storeFields(tx as unknown as Record<string, unknown>)) {
        if (!undoable(store)) missing.push(name);
      }
    });
    expect(missing).toEqual([]);
  });

  it('WS-G/WS-Q forum — rooms + the identity trail', async () => {
    const forum = createInMemoryForumServices();
    const missing: string[] = [];
    await forum.transact(async (tx) => {
      for (const [name, store] of storeFields(tx as unknown as Record<string, unknown>)) {
        if (!undoable(store)) missing.push(name);
      }
    });
    expect(missing).toEqual([]);
  });

  it('WS-D identity — the store and its audit', async () => {
    const missing: string[] = [];
    await identity.transact(async (tx) => {
      for (const [name, store] of storeFields(tx as unknown as Record<string, unknown>)) {
        if (!undoable(store)) missing.push(name);
      }
    });
    expect(missing).toEqual([]);
  });

  it('WS-N compliance — its own chain plus the WS-D stores it spans', async () => {
    const compliance = createInMemoryComplianceServices({
      configStore: new InMemoryPwattConfigStore(),
    });
    const missing: string[] = [];
    await compliance.transactor.run(async (stores) => {
      for (const [name, store] of storeFields(stores as unknown as Record<string, unknown>)) {
        if (!undoable(store)) missing.push(name);
      }
    });
    expect(missing).toEqual([]);
  });

  it('ROLLS BACK for real: a throw leaves no ingestion row behind', async () => {
    // The generic check above proves the wiring; this proves the wiring works.
    const ingestion = createInMemoryIngestionServices();
    const takedownId = '11111111-1111-4111-8111-111111111111';
    await expect(
      ingestion.transact(async (tx) => {
        await tx.takedowns.insert({
          takedownId,
          targetType: 'story',
          targetId: '22222222-2222-4222-8222-222222222222',
          requesterContact: 'rights@example.com',
          legalBasis: 'copyright',
          claimDetail: 'Reproduces our article in full.',
          status: 'received',
          resolutionNote: null,
          actionedBy: null,
          actionedAt: null,
        });
        throw new Error('the record failed');
      }),
    ).rejects.toThrow('the record failed');
    expect(await ingestion.takedowns.getById(takedownId)).toBeNull();
  });
});
