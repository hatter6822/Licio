// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.3.6a — the ranking-firewalled standing reads.  Structural firewall:
// NO ranking / feed / search / notification / recommendation / forum-posting
// module imports the standing client (transitive import-graph scan), plus the
// behavioural guarantees: standing withheld under flag-off and the wallet
// kill switch, per-wallet actor resolution (no cross-wallet leak), and a
// gateway failure degrades closed.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { storeKnomosisConfigValue } from '../knomosis/config.js';
import { activateKillSwitch } from '../knomosis/killswitch.js';
import {
  ensureActorMapping,
  readBalances,
  readBudget,
  type StandingDeps,
} from '../knomosis/standing.js';
import { seedUserWithSession } from './event-test-helpers.js';
import {
  freshKnomosisServices,
  type KnomosisFixture,
  LOCAL_DEPLOYMENT,
  resetKnomosisFixture,
  testAccount,
  testAccount2,
} from './knomosis-test-helpers.js';

const DEPLOYMENT = LOCAL_DEPLOYMENT.deployment_id;

afterEach(() => resetKnomosisFixture());

function standingDeps(fixture: KnomosisFixture): StandingDeps {
  const s = fixture.knomosis;
  return {
    wallets: s.wallets,
    actorMappings: s.actorMappings,
    gateway: s.gateway,
    configStore: s.configStore,
    cryptoEnabled: () => s.config().cryptoEnabled,
    regionForUser: (userId) => s.regionResolver.regionForUser(userId),
    now: s.now,
    log: s.log,
  };
}

async function linkAndMap(
  fixture: KnomosisFixture,
  userId: string,
  account = testAccount,
): Promise<string> {
  const walletAccountId = fixture.knomosis.uuid();
  await fixture.knomosis.wallets.insert({
    walletAccountId,
    userId,
    addressHashHex: `hash-${account.address.toLowerCase()}`,
    addressTruncated: '0x1234…5678',
    chainId: LOCAL_DEPLOYMENT.chain_id,
    walletType: 'eoa',
    unlinkState: 'active',
    riskState: 'normal',
    label: null,
    linkedAt: new Date().toISOString(),
    lastUsedAt: null,
    unlinkRequestedAt: null,
    unlinkFinalizeAfter: null,
    unlinkedAt: null,
  });
  await ensureActorMapping(fixture.knomosis, {
    walletAccountId,
    deploymentId: DEPLOYMENT,
    actorLower: account.address.toLowerCase(),
  });
  fixture.gateway.setBalance(account.address.toLowerCase(), 'USDC', '250');
  return walletAccountId;
}

describe('WS-L.3.6a standing firewall — structural', () => {
  // The transitive import closure of every non-financial serving surface must
  // never reach the standing client (the pay-to-rank read path).
  function transitiveClosure(rootDirs: string[]): Set<string> {
    const srcRoot = resolve(import.meta.dirname, '..');
    const specifiers = new Set<string>();
    const visited = new Set<string>();
    const queue: string[] = [];
    for (const dir of rootDirs) {
      const abs = resolve(srcRoot, dir);
      if (!existsSync(abs)) continue;
      for (const name of readdirSync(abs)) {
        if (name.endsWith('.ts') && !name.endsWith('.test.ts')) queue.push(resolve(abs, name));
      }
    }
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const m of readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1] as string;
        specifiers.add(spec);
        if (!spec.startsWith('.')) continue;
        const base = resolve(dirname(file), spec.replace(/\.js$/, ''));
        for (const c of [`${base}.ts`, resolve(base, 'index.ts')]) {
          if (existsSync(c)) {
            queue.push(c);
            break;
          }
        }
      }
    }
    return specifiers;
  }

  it('no ranking/feed/search/forum surface imports the standing client', () => {
    const closure = transitiveClosure(['ranking', 'forum', 'ingestion']);
    for (const spec of closure) {
      expect(spec.includes('knomosis/standing'), `unexpected standing import: ${spec}`).toBe(false);
    }
  });
});

describe('WS-L.3.6a standing firewall — behavioural', () => {
  it('withholds standing when the crypto flag is off (fail closed)', async () => {
    const fixture = await freshKnomosisServices({ cryptoEnabled: false });
    const { userId } = await seedUserWithSession(fixture.identity);
    const walletAccountId = await linkAndMap(fixture, userId);
    const result = await readBalances(standingDeps(fixture), {
      userId,
      walletAccountId,
      deploymentId: DEPLOYMENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('crypto_disabled');
  });

  it('withholds standing under the wallet-connection kill switch', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const walletAccountId = await linkAndMap(fixture, userId);
    await activateKillSwitch(
      {
        configStore: fixture.knomosis.configStore,
        audit: fixture.knomosis.audit,
        now: fixture.knomosis.now,
        log: () => {},
      },
      {
        switchId: 'wallet_connection',
        scopes: { global: true, regions: [], room_ids: [] },
        releaseCard: {
          owner: 'op',
          trigger_condition: 't',
          rollback_path: 'r',
          review_date: '2026-08-01T00:00:00.000Z',
        },
        actorUserId: '11111111-1111-4111-8111-111111111111',
        reason: 'incident',
      },
    );
    const result = await readBalances(standingDeps(fixture), {
      userId,
      walletAccountId,
      deploymentId: DEPLOYMENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('kill_switch_active');
  });

  it('resolves per SELECTED wallet: a two-wallet user never leaks cross-wallet standing', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const walletA = await linkAndMap(fixture, userId, testAccount);
    const walletB = await linkAndMap(fixture, userId, testAccount2);
    fixture.gateway.setBalance(testAccount.address.toLowerCase(), 'USDC', '100');
    fixture.gateway.setBalance(testAccount2.address.toLowerCase(), 'USDC', '900');
    const a = await readBalances(standingDeps(fixture), {
      userId,
      walletAccountId: walletA,
      deploymentId: DEPLOYMENT,
    });
    const b = await readBalances(standingDeps(fixture), {
      userId,
      walletAccountId: walletB,
      deploymentId: DEPLOYMENT,
    });
    if (a.ok && b.ok) {
      expect(a.value['USDC']).toBe('100');
      expect(b.value['USDC']).toBe('900');
    } else {
      throw new Error('reads failed');
    }
  });

  it('rejects a wallet the caller does not own (no cross-user oracle)', async () => {
    const fixture = await freshKnomosisServices();
    const owner = await seedUserWithSession(fixture.identity, { handle: 'owner1' });
    const attacker = await seedUserWithSession(fixture.identity, { handle: 'attacker1' });
    const walletAccountId = await linkAndMap(fixture, owner.userId);
    const result = await readBalances(standingDeps(fixture), {
      userId: attacker.userId, // not the owner
      walletAccountId,
      deploymentId: DEPLOYMENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('wallet_not_active');
  });

  it('a gateway outage degrades to standing_unavailable, never open', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const walletAccountId = await linkAndMap(fixture, userId);
    fixture.gateway.offline = true;
    const result = await readBalances(standingDeps(fixture), {
      userId,
      walletAccountId,
      deploymentId: DEPLOYMENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('standing_unavailable');
  });

  it('withholds standing when the crypto config value is later flipped off', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const walletAccountId = await linkAndMap(fixture, userId);
    // A live disable takes immediate effect on reload (fail-closed in the OFF direction).
    await storeKnomosisConfigValue(fixture.knomosis.configStore, 'cryptoEnabled', false);
    await fixture.knomosis.reloadConfig();
    const result = await readBalances(standingDeps(fixture), {
      userId,
      walletAccountId,
      deploymentId: DEPLOYMENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('crypto_disabled');
  });

  it('reads budget (honest lower bound) and honours a conditional 304', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const walletAccountId = await linkAndMap(fixture, userId);
    const budget = await readBudget(standingDeps(fixture), {
      userId,
      walletAccountId,
      deploymentId: DEPLOYMENT,
    });
    expect(budget.ok).toBe(true);
    if (budget.ok) expect(budget.value.isLowerBound).toBe(true);

    // A conditional balances read whose ETag matches is `not_modified`.
    const first = await readBalances(standingDeps(fixture), {
      userId,
      walletAccountId,
      deploymentId: DEPLOYMENT,
    });
    if (first.ok) {
      const conditional = await readBalances(standingDeps(fixture), {
        userId,
        walletAccountId,
        deploymentId: DEPLOYMENT,
        etag: first.etag,
      });
      expect(conditional.ok).toBe(false);
      if (!conditional.ok) expect(conditional.code).toBe('not_modified');
    }
  });

  it('a wallet with no actor mapping cannot resolve standing', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    // Link WITHOUT an actor mapping.
    const walletAccountId = fixture.knomosis.uuid();
    await fixture.knomosis.wallets.insert({
      walletAccountId,
      userId,
      addressHashHex: 'hash-none',
      addressTruncated: '0x0000…0000',
      chainId: LOCAL_DEPLOYMENT.chain_id,
      walletType: 'eoa',
      unlinkState: 'active',
      riskState: 'normal',
      label: null,
      linkedAt: new Date().toISOString(),
      lastUsedAt: null,
      unlinkRequestedAt: null,
      unlinkFinalizeAfter: null,
      unlinkedAt: null,
    });
    const result = await readBalances(standingDeps(fixture), {
      userId,
      walletAccountId,
      deploymentId: DEPLOYMENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_actor_mapping');
  });
});
