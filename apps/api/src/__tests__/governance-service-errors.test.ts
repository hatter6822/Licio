// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U GovernanceService error paths (fail-closed branches).
import { describe, expect, it } from 'vitest';
import { resolveGovernanceConfig } from '../governance/config.js';
import { createGovernanceService } from '../governance/services.js';
import { createInMemoryGovernanceStores } from '../governance/stores.js';

function make(cryptoEnabled = false) {
  let n = 0;
  return createGovernanceService({
    stores: createInMemoryGovernanceStores(),
    config: resolveGovernanceConfig({
      cryptoEnabled,
      electionTermSeconds: 1,
      electionWindowSeconds: 1,
    }),
    now: () => new Date('2026-06-19T00:00:00.000Z'),
    uuid: () => `id-${++n}`,
  });
}

const bundle = (over: Record<string, unknown> = {}) => ({
  bundleId: 'b',
  version: '1',
  name: 'n',
  moderationRules: [
    { id: 'spam', when: { kind: 'link_count_gte', value: 3 }, action: 'remove', reason: 'links' },
  ],
  promptTemplates: {},
  config: {},
  requestedCapabilities: ['moderate.remove', 'moderate.flag'],
  ...over,
});

describe('GovernanceService error paths', () => {
  it('schedule/settle election guards', async () => {
    const svc = make();
    expect((await svc.scheduleElection('r')).ok).toBe(false); // no_seat
    await svc.bootstrapSeat('r', 'c'); // termSeconds=1 ⇒ term already elapsed at fixed clock+1s? no
    expect((await svc.settleElection('missing', 1)).ok).toBe(false); // not_found
  });

  it('proposeModel guards: invalid bundle and duplicate digest', async () => {
    const svc = make();
    await svc.bootstrapSeat('r', 's');
    expect((await svc.proposeModel('r', 's', { not: 'a bundle' }, 'p')).ok).toBe(false);
    expect((await svc.proposeModel('r', 's', bundle(), 'p')).ok).toBe(true);
    expect((await svc.proposeModel('r', 's', bundle(), 'p')).ok).toBe(false); // duplicate digest
  });

  it('evaluate/approve guards', async () => {
    const svc = make();
    await svc.bootstrapSeat('r', 's');
    expect((await svc.evaluateModel('missing')).ok).toBe(false); // not_found
    const p = await svc.proposeModel('r', 's', bundle(), 'p');
    const id = p.ok ? p.value.modelId : '';
    expect((await svc.approveModel('r', 'missing', null, null)).ok).toBe(false); // not_found
    expect((await svc.approveModel('r', id, null, null)).ok).toBe(false); // not_eligible (un-evaluated)
  });

  it('treasury guards (crypto on): no agent, then missing capability', async () => {
    const svc = make(true);
    await svc.bootstrapSeat('r', 's');
    const input = {
      category: 'transparency_report',
      amount: 0,
      asset: null,
      coiDeclared: false,
      proposedAt: '2026-06-19T00:00:00.000Z',
    };
    expect((await svc.executeTreasuryAction('r', input)).ok).toBe(false); // no_agent
    const p = await svc.proposeModel('r', 's', bundle(), 'p'); // no gateway capability
    const id = p.ok ? p.value.modelId : '';
    await svc.evaluateModel(id);
    await svc.approveModel('r', id, null, null);
    expect((await svc.executeTreasuryAction('r', input)).ok).toBe(false); // no_capability
  });

  it('proposeLawPack rejects an invalid law-pack', async () => {
    const svc = make(true);
    expect((await svc.proposeLawPack('r', { bad: true })).ok).toBe(false);
  });
});
