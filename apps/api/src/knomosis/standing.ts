// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.3.6a — the RANKING-FIREWALLED Knomosis standing-read client (gateway
// plan G1: read-only, no key custody, no write risk).  Standing (balances /
// budget) is resolved per SELECTED LINKED WALLET (`wallet_account_id`, with
// ownership verified — never a bare account address, so a user's other
// wallets' standing is never returned), validated through zod (the gateway
// client), tagged with the `X-Knomosis-Seq` cursor + weak ETag, and consumed
// STRICTLY inside the knomosis bounded context (governance weight, treasury
// views, action eligibility).
//
// DOCTRINE (ABSOLUTE — SPEC §17.1 boundary 1; WS-M invariant 4): no value
// returned here may reach any ranking, search, notification, trend, or
// recommendation feature, and no topic/content-access or posting-eligibility
// path may read it — a user without holdings keeps full social participation.
// Structural enforcement: the WS-D.3.2 isolation test covers the standing
// tables; the WS-I.2.1b financial denylist rejects any attempt to register a
// standing value as a ranking feature; and a static import-graph test asserts
// no ranking/feed/search/notification/forum-eligibility module imports this
// file.  Reads are withheld when the crypto flag is off and under the
// wallet-connection kill switch; a gateway failure degrades to "standing
// unavailable" — never open.

import type { PwattConfigStore } from '../events/stores.js';
import type { GatewayBalances, GatewayBudget, KnomosisGateway } from './gateway.js';
import { killSwitchDecision } from './killswitch.js';
import type { FinancialWalletStore, WalletActorMappingStore } from './stores.js';

export interface StandingDeps {
  wallets: FinancialWalletStore;
  actorMappings: WalletActorMappingStore;
  gateway: () => KnomosisGateway | null;
  configStore: PwattConfigStore;
  cryptoEnabled: () => boolean;
  regionForUser: (userId: string) => Promise<string | null>;
  now: () => number;
  log: (event: string, meta: Record<string, unknown>) => void;
}

export type StandingResult<T> =
  | { ok: true; value: T; knomosisSeq: string; etag: string | null }
  | {
      ok: false;
      code:
        | 'crypto_disabled'
        | 'kill_switch_active'
        | 'wallet_not_active'
        | 'no_actor_mapping'
        | 'standing_unavailable'
        /** Conditional-read hit (ETag match): the caller's snapshot is current. */
        | 'not_modified';
    };

async function resolveActor(
  deps: StandingDeps,
  userId: string,
  walletAccountId: string,
  deploymentId: string,
): Promise<{ ok: true; actorId: string } | Extract<StandingResult<never>, { ok: false }>> {
  // Fail-closed gates FIRST: flag, then the wallet-connection kill switch.
  if (!deps.cryptoEnabled()) return { ok: false, code: 'crypto_disabled' };
  const region = await deps.regionForUser(userId);
  const decision = await killSwitchDecision(deps.configStore, 'wallet_connection', { region });
  if (decision.engaged) return { ok: false, code: 'kill_switch_active' };

  // Ownership: the SELECTED wallet must belong to the caller and be active —
  // a mismatch is indistinguishable from absence (no cross-user oracle).
  const wallet = await deps.wallets.getById(walletAccountId);
  if (wallet === null || wallet.userId !== userId || wallet.unlinkState !== 'active') {
    return { ok: false, code: 'wallet_not_active' };
  }
  const mapping = await deps.actorMappings.get(walletAccountId, deploymentId);
  if (mapping === null) return { ok: false, code: 'no_actor_mapping' };
  return { ok: true, actorId: mapping.actorId };
}

/** Balances for the selected wallet's gateway actor (absent cells read "0"). */
export async function readBalances(
  deps: StandingDeps,
  args: {
    userId: string;
    walletAccountId: string;
    deploymentId: string;
    etag?: string | null;
  },
): Promise<StandingResult<GatewayBalances>> {
  const actor = await resolveActor(deps, args.userId, args.walletAccountId, args.deploymentId);
  if (!actor.ok) return actor;
  const gateway = deps.gateway();
  if (gateway === null) return { ok: false, code: 'standing_unavailable' };
  const read = await gateway.getBalances(actor.actorId, args.etag ?? null);
  if (read.kind === 'unavailable') {
    deps.log('knomosis.standing.unavailable', { detail: read.detail });
    return { ok: false, code: 'standing_unavailable' };
  }
  if (read.kind === 'not_modified') return { ok: false, code: 'not_modified' };
  return { ok: true, value: read.value, knomosisSeq: read.knomosisSeq, etag: read.etag };
}

/** Budget (honest lower bound until the gateway's authoritative read, G6). */
export async function readBudget(
  deps: StandingDeps,
  args: {
    userId: string;
    walletAccountId: string;
    deploymentId: string;
    etag?: string | null;
  },
): Promise<StandingResult<GatewayBudget>> {
  const actor = await resolveActor(deps, args.userId, args.walletAccountId, args.deploymentId);
  if (!actor.ok) return actor;
  const gateway = deps.gateway();
  if (gateway === null) return { ok: false, code: 'standing_unavailable' };
  const read = await gateway.getBudget(actor.actorId, args.etag ?? null);
  if (read.kind === 'unavailable') return { ok: false, code: 'standing_unavailable' };
  if (read.kind === 'not_modified') return { ok: false, code: 'not_modified' };
  return { ok: true, value: read.value, knomosisSeq: read.knomosisSeq, etag: read.etag };
}

/**
 * Record the wallet→actor mapping at submission time (the verified `actor`
 * address IS the gateway actor id).  Address-bearing identifiers live ONLY in
 * the knomosis bounded context (isolation-tested).
 */
export async function ensureActorMapping(
  deps: Pick<StandingDeps, 'actorMappings' | 'now'>,
  args: { walletAccountId: string; deploymentId: string; actorLower: string },
): Promise<void> {
  const existing = await deps.actorMappings.get(args.walletAccountId, args.deploymentId);
  if (existing !== null) return;
  await deps.actorMappings.put({
    walletAccountId: args.walletAccountId,
    deploymentId: args.deploymentId,
    actorId: args.actorLower,
    createdAt: new Date(deps.now()).toISOString(),
  });
}
