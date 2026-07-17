// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.3a + WS-L.2.5a-d — the wallet-link lifecycle over REAL SIWE crypto:
// nonce issue → EIP-4361 sign → link, idempotent re-link, cross-user address
// denial, the wallet cap, the re-link cooldown, obligation-blocked unlink,
// cooling-off + finalization sweep, labels, the fail-closed risk state, and
// the abuse limits (attempt-counted, alert on excess).

import { afterEach, describe, expect, it } from 'vitest';
import { KNOMOSIS_PIN } from '../knomosis/pin.js';
import {
  finalizeElapsedUnlinks,
  issueWalletLinkNonce,
  linkWallet,
  listWallets,
  requestUnlink,
  setWalletLabel,
  type WalletServiceDeps,
  walletRiskState,
} from '../knomosis/wallet.js';
import { seedUserWithSession } from './event-test-helpers.js';
import type { KnomosisFixture } from './knomosis-test-helpers.js';
import {
  freshKnomosisServices,
  resetKnomosisFixture,
  signedSiweLink,
  testAccount,
} from './knomosis-test-helpers.js';

function walletDeps(fixture: KnomosisFixture, now?: () => number): WalletServiceDeps {
  const services = fixture.knomosis;
  return {
    wallets: services.wallets,
    actions: services.actions,
    proposalSignatures: services.proposalSignatures,
    compliance: services.compliance,
    treasuryObligations: services.treasuryObligations,
    ephemeral: services.ephemeral,
    audit: services.audit,
    abuse: services.abuse,
    masterSecret: services.masterSecret,
    siweBase: services.siweBase,
    chainAllowlist: () => [
      ...new Set(KNOMOSIS_PIN.deployments.flatMap((d) => [d.chain_id, d.l1_chain_id])),
    ],
    config: services.config,
    now: now ?? services.now,
    uuid: services.uuid,
    log: services.log,
    alert: services.alert,
  };
}

async function linkTestWallet(
  fixture: KnomosisFixture,
  userId: string,
  session: string,
  account = testAccount,
  now?: () => number,
) {
  const deps = walletDeps(fixture, now);
  const nonce = await issueWalletLinkNonce(deps, { userId, sessionTokenHash: session });
  if (!nonce.ok) throw new Error(`nonce failed: ${nonce.code}`);
  const signed = await signedSiweLink(nonce.nonce, account, now ? { nowMs: now() } : {});
  return linkWallet(deps, {
    userId,
    sessionTokenHash: session,
    message: signed.message,
    signature: signed.signature,
  });
}

afterEach(() => resetKnomosisFixture());

describe('WS-L.2.3a nonce + WS-L.2.5a link (REAL SIWE)', () => {
  it('links a wallet end-to-end: nonce → sign → verify → record', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const result = await linkTestWallet(fixture, userId, 's1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyLinked).toBe(false);
    expect(result.wallet.walletType).toBe('eoa');
    expect(result.wallet.unlinkState).toBe('active');
    // Fail-closed default until the first WS-N assessment (WS-L.2.5c-1).
    expect(result.wallet.riskState).toBe('pending');
    // Data minimization: no full address anywhere on the record (§19.5).
    const serialized = JSON.stringify(result.wallet);
    expect(serialized.toLowerCase()).not.toContain(testAccount.address.toLowerCase());
    expect(result.wallet.addressTruncated).toMatch(/^0x.{4}…?.*$/i);
    // Audit entry carries the truncation only.
    const audit = await fixture.identity.audit.securityActivityForUser(userId);
    const link = audit.find((entry) => entry.event_type === 'wallet_link');
    expect(link).toBeDefined();
    expect(JSON.stringify(link).toLowerCase()).not.toContain(
      testAccount.address.toLowerCase().slice(2),
    );
  });

  it('a nonce is single-use: replaying the same signed message fails', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const deps = walletDeps(fixture);
    const nonce = await issueWalletLinkNonce(deps, { userId, sessionTokenHash: 's1' });
    if (!nonce.ok) throw new Error('nonce failed');
    const signed = await signedSiweLink(nonce.nonce);
    const first = await linkWallet(deps, {
      userId,
      sessionTokenHash: 's1',
      message: signed.message,
      signature: signed.signature,
    });
    expect(first.ok).toBe(true);
    const replay = await linkWallet(deps, {
      userId,
      sessionTokenHash: 's1',
      message: signed.message,
      signature: signed.signature,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.code).toBe('siwe_nonce_invalid');
  });

  it('cross-session nonce usage is rejected (session binding)', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const deps = walletDeps(fixture);
    const nonce = await issueWalletLinkNonce(deps, { userId, sessionTokenHash: 'session-A' });
    if (!nonce.ok) throw new Error('nonce failed');
    const signed = await signedSiweLink(nonce.nonce);
    const result = await linkWallet(deps, {
      userId,
      sessionTokenHash: 'session-B', // different session
      message: signed.message,
      signature: signed.signature,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a message signed for the WRONG domain (anti-phishing)', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const deps = walletDeps(fixture);
    const nonce = await issueWalletLinkNonce(deps, { userId, sessionTokenHash: 's1' });
    if (!nonce.ok) throw new Error('nonce failed');
    const signed = await signedSiweLink(nonce.nonce, testAccount, { domain: 'evil.example' });
    const result = await linkWallet(deps, {
      userId,
      sessionTokenHash: 's1',
      message: signed.message,
      signature: signed.signature,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('siwe_domain_mismatch');
  });

  it('rejects a chain outside the pinned allowlist (fail closed)', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const deps = walletDeps(fixture);
    const nonce = await issueWalletLinkNonce(deps, { userId, sessionTokenHash: 's1' });
    if (!nonce.ok) throw new Error('nonce failed');
    const signed = await signedSiweLink(nonce.nonce, testAccount, { chainId: 999999 });
    const result = await linkWallet(deps, {
      userId,
      sessionTokenHash: 's1',
      message: signed.message,
      signature: signed.signature,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('siwe_chain_not_allowed');
  });

  it('accepts a link on the L1 settlement chain (Sepolia) via the pinned allowlist', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const deps = walletDeps(fixture);
    const nonce = await issueWalletLinkNonce(deps, { userId, sessionTokenHash: 's1' });
    if (!nonce.ok) throw new Error('nonce failed');
    // 11155111 (Sepolia L1) is NOT the deployment's L2 chain (8357) but IS its
    // `l1_chain_id`, so the pin-derived allowlist accepts it (WS-L.2.5a).
    const signed = await signedSiweLink(nonce.nonce, testAccount, { chainId: 11155111 });
    const result = await linkWallet(deps, {
      userId,
      sessionTokenHash: 's1',
      message: signed.message,
      signature: signed.signature,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.wallet.chainId).toBe(11155111);
  });

  it('re-linking the same wallet is idempotent (same record, already_linked)', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const first = await linkTestWallet(fixture, userId, 's1');
    const second = await linkTestWallet(fixture, userId, 's1');
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.alreadyLinked).toBe(true);
    expect(second.wallet.walletAccountId).toBe(first.wallet.walletAccountId);
  });

  it('an address linked by ANOTHER account cannot be linked (no oracle)', async () => {
    const fixture = await freshKnomosisServices();
    const alice = await seedUserWithSession(fixture.identity, { handle: 'alice1' });
    const bob = await seedUserWithSession(fixture.identity, { handle: 'bob1' });
    const first = await linkTestWallet(fixture, alice.userId, 'sA');
    expect(first.ok).toBe(true);
    const second = await linkTestWallet(fixture, bob.userId, 'sB');
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(409);
      expect(second.code).toBe('address_unavailable');
    }
  });

  it('maps the store address-lock race to address_unavailable (H1)', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const deps = walletDeps(fixture);
    // The fast pre-check sees no owner, but the store's per-address lock catches a
    // CONCURRENT cross-chain link claiming the address at insert time → 'address_taken'.
    // Simulate that race by forcing the atomic insert to report the address taken.
    deps.wallets.insertIfUnderCap = async () => 'address_taken';
    const nonce = await issueWalletLinkNonce(deps, { userId, sessionTokenHash: 's1' });
    if (!nonce.ok) throw new Error('nonce failed');
    const signed = await signedSiweLink(nonce.nonce);
    const result = await linkWallet(deps, {
      userId,
      sessionTokenHash: 's1',
      message: signed.message,
      signature: signed.signature,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      // No enumeration oracle: the same opaque failure as the sequential pre-check.
      expect(result.code).toBe('address_unavailable');
    }
  });

  it('links the SAME address on TWO active chains as distinct per-chain rows (G1)', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    // The two Knomosis wallet chains: the L2 (8357) and its L1 settlement chain
    // (Sepolia, 11155111) — both in the allowlist for this test.
    const deps = { ...walletDeps(fixture), chainAllowlist: () => [8357, 11155111] };
    const linkOn = async (session: string, chainId: number) => {
      const nonce = await issueWalletLinkNonce(deps, { userId, sessionTokenHash: session });
      if (!nonce.ok) throw new Error('nonce failed');
      const signed = await signedSiweLink(nonce.nonce, testAccount, { chainId });
      return linkWallet(deps, {
        userId,
        sessionTokenHash: session,
        message: signed.message,
        signature: signed.signature,
      });
    };
    const link1 = await linkOn('s1', 8357);
    expect(link1.ok).toBe(true);
    if (link1.ok) expect(link1.alreadyLinked).toBe(false);
    // The SAME address on a DIFFERENT active chain → a NEW row (not already_linked),
    // instead of returning the L2 wallet that the chain gate would then reject.
    const link2 = await linkOn('s2', 11155111);
    expect(link2.ok).toBe(true);
    if (link2.ok) {
      expect(link2.alreadyLinked).toBe(false);
      expect(link2.wallet.chainId).toBe(11155111);
    }
    const wallets = await fixture.knomosis.wallets.listByUser(userId, false);
    expect(wallets).toHaveLength(2);
    expect(new Set(wallets.map((w) => w.chainId))).toEqual(new Set([8357, 11155111]));
  });

  it('enforces the max-wallets cap (WS-L.2.5d)', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    // Simulate an at-cap user by inserting cap-1 synthetic wallets directly.
    const cap = fixture.knomosis.config().maxWalletsPerUser;
    for (let i = 0; i < cap; i += 1) {
      await fixture.knomosis.wallets.insert({
        walletAccountId: crypto.randomUUID(),
        userId,
        addressHashHex: `aa${i.toString().padStart(62, '0')}`,
        addressTruncated: `0x0${i}…ff`,
        chainId: 8357,
        walletType: 'eoa',
        unlinkState: 'active',
        riskState: 'pending',
        label: null,
        linkedAt: new Date().toISOString(),
        lastUsedAt: null,
        unlinkRequestedAt: null,
        unlinkFinalizeAfter: null,
        unlinkedAt: null,
      });
    }
    const result = await linkTestWallet(fixture, userId, 's1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('wallet_limit');
  });
});

describe('WS-L.2.5b unlink lifecycle + WS-L.2.5c list/label', () => {
  it('unlink with no obligations → pending_unlink with cooling-off, then finalizes', async () => {
    let clock = Date.now();
    const fixture = await freshKnomosisServices({ now: () => clock });
    const { userId } = await seedUserWithSession(fixture.identity);
    const linked = await linkTestWallet(fixture, userId, 's1', testAccount, () => clock);
    if (!linked.ok) throw new Error('link failed');
    const deps = walletDeps(fixture, () => clock);

    const unlink = await requestUnlink(deps, {
      userId,
      walletAccountId: linked.wallet.walletAccountId,
    });
    expect('blocked' in unlink).toBe(false);
    if (!('ok' in unlink) || unlink.ok !== true) throw new Error('unlink not accepted');
    expect(unlink.wallet.unlinkState).toBe('pending_unlink');

    // Cooling-off prevents immediate finalization…
    expect(await finalizeElapsedUnlinks(deps)).toBe(0);
    // …until the window elapses (default 24h).
    clock += 25 * 3_600_000;
    expect(await finalizeElapsedUnlinks(deps)).toBe(1);
    const after = await fixture.knomosis.wallets.getById(linked.wallet.walletAccountId);
    expect(after?.unlinkState).toBe('finalized');
    // Removed from the default list; retained for audit with include_unlinked.
    expect(await listWallets(deps, { userId, includeUnlinked: false })).toHaveLength(0);
    expect(await listWallets(deps, { userId, includeUnlinked: true })).toHaveLength(1);
  });

  it('a FINALIZED unlink releases the address for a DIFFERENT account (K3)', async () => {
    let clock = Date.now();
    const fixture = await freshKnomosisServices({ now: () => clock });
    const alice = await seedUserWithSession(fixture.identity, { handle: 'alicek3' });
    const bob = await seedUserWithSession(fixture.identity, { handle: 'bobk3' });
    const aliceLink = await linkTestWallet(fixture, alice.userId, 'sA', testAccount, () => clock);
    if (!aliceLink.ok) throw new Error('alice link failed');
    const deps = walletDeps(fixture, () => clock);
    // While Alice's link is LIVE, Bob cannot link the SAME wallet (cross-user).
    const blocked = await linkTestWallet(fixture, bob.userId, 'sB', testAccount, () => clock);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe('address_unavailable');
    // Alice unlinks; the cooling-off elapses → finalized (tombstone retained).
    await requestUnlink(deps, {
      userId: alice.userId,
      walletAccountId: aliceLink.wallet.walletAccountId,
    });
    clock += 25 * 3_600_000;
    expect(await finalizeElapsedUnlinks(deps)).toBe(1);
    // The address is RELEASED: Bob (who proves key control by signing the SIWE
    // message with the same key) can now link it — previously blocked forever.
    const bobLink = await linkTestWallet(fixture, bob.userId, 'sB', testAccount, () => clock);
    expect(bobLink.ok).toBe(true);
    if (bobLink.ok) {
      expect(bobLink.alreadyLinked).toBe(false);
      expect(bobLink.wallet.unlinkState).toBe('active');
    }
    // Alice's finalized tombstone is retained for audit; Bob owns the live row.
    expect(await listWallets(deps, { userId: alice.userId, includeUnlinked: true })).toHaveLength(
      1,
    );
    expect(await listWallets(deps, { userId: bob.userId, includeUnlinked: false })).toHaveLength(1);
  });

  it('re-linking during cooling-off CANCELS the unlink', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const linked = await linkTestWallet(fixture, userId, 's1');
    if (!linked.ok) throw new Error('link failed');
    const deps = walletDeps(fixture);
    await requestUnlink(deps, { userId, walletAccountId: linked.wallet.walletAccountId });
    const relink = await linkTestWallet(fixture, userId, 's1');
    expect(relink.ok).toBe(true);
    if (relink.ok) expect(relink.wallet.unlinkState).toBe('active');
  });

  it('re-linking a FINALIZED wallet inside the cooldown is blocked (WS-L.2.5d)', async () => {
    let clock = Date.now();
    const fixture = await freshKnomosisServices({ now: () => clock });
    const { userId } = await seedUserWithSession(fixture.identity);
    const linked = await linkTestWallet(fixture, userId, 's1', testAccount, () => clock);
    if (!linked.ok) throw new Error('link failed');
    const deps = walletDeps(fixture, () => clock);
    await requestUnlink(deps, { userId, walletAccountId: linked.wallet.walletAccountId });
    clock += 25 * 3_600_000;
    await finalizeElapsedUnlinks(deps);

    // Inside the 7-day cooldown: blocked.
    clock += 3_600_000;
    const early = await linkTestWallet(fixture, userId, 's1', testAccount, () => clock);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.code).toBe('relink_cooldown');

    // After the cooldown: reactivates with fail-closed risk.
    clock += 8 * 24 * 3_600_000;
    const late = await linkTestWallet(fixture, userId, 's1', testAccount, () => clock);
    expect(late.ok).toBe(true);
    if (late.ok) expect(late.wallet.riskState).toBe('pending');
  });

  it('re-linking a FINALIZED wallet while AT the cap is blocked (WS-L.2.5a review fix)', async () => {
    let clock = Date.now();
    const fixture = await freshKnomosisServices({ now: () => clock });
    const { userId } = await seedUserWithSession(fixture.identity);
    // Link then finalize W1.
    const linked = await linkTestWallet(fixture, userId, 's1', testAccount, () => clock);
    if (!linked.ok) throw new Error('link failed');
    const deps = walletDeps(fixture, () => clock);
    await requestUnlink(deps, { userId, walletAccountId: linked.wallet.walletAccountId });
    clock += 25 * 3_600_000;
    await finalizeElapsedUnlinks(deps);
    // Advance PAST the re-link cooldown so ONLY the cap can block reactivation.
    clock += 8 * 24 * 3_600_000;
    // Meanwhile the user filled the cap with OTHER active wallets.
    const cap = fixture.knomosis.config().maxWalletsPerUser;
    for (let i = 0; i < cap; i += 1) {
      await fixture.knomosis.wallets.insert({
        walletAccountId: crypto.randomUUID(),
        userId,
        addressHashHex: `bb${i.toString().padStart(62, '0')}`,
        addressTruncated: `0x1${i}…ee`,
        chainId: 8357,
        walletType: 'eoa',
        unlinkState: 'active',
        riskState: 'pending',
        label: null,
        linkedAt: new Date(clock).toISOString(),
        lastUsedAt: null,
        unlinkRequestedAt: null,
        unlinkFinalizeAfter: null,
        unlinkedAt: null,
      });
    }
    // Reactivating W1 would make cap+1 active wallets — blocked like a fresh link.
    const over = await linkTestWallet(fixture, userId, 's1', testAccount, () => clock);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe('wallet_limit');
    // The finalized wallet is untouched (still finalized), not silently reactivated.
    const w1 = await fixture.knomosis.wallets.getById(linked.wallet.walletAccountId);
    expect(w1?.unlinkState).toBe('finalized');
  });

  it('an open signed action BLOCKS the unlink with the specific obligation', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const linked = await linkTestWallet(fixture, userId, 's1');
    if (!linked.ok) throw new Error('link failed');
    await fixture.knomosis.actions.insert({
      actionRecordId: crypto.randomUUID(),
      deploymentId: crypto.randomUUID(),
      actionType: 'treasury_deposit',
      roomId: crypto.randomUUID(),
      actorWalletAccountId: linked.wallet.walletAccountId,
      actorUserId: userId,
      payloadHash: `0x${'11'.repeat(32)}`,
      typedDataHash: `0x${'11'.repeat(32)}`,
      signedAction: { message: {}, signature: '0x' },
      submissionState: 'accepted', // non-terminal ⇒ an obligation
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: crypto.randomUUID(),
      paymentIntentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const deps = walletDeps(fixture);
    const unlink = await requestUnlink(deps, {
      userId,
      walletAccountId: linked.wallet.walletAccountId,
    });
    expect('blocked' in unlink && unlink.blocked).toBe(true);
    if ('blocked' in unlink) {
      expect(unlink.obligations[0]?.type).toBe('pending_payment');
    }
  });

  it('labels default to "Wallet N" and PATCH updates them (WS-L.2.5c)', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const linked = await linkTestWallet(fixture, userId, 's1');
    if (!linked.ok) throw new Error('link failed');
    const deps = walletDeps(fixture);
    const before = await listWallets(deps, { userId, includeUnlinked: false });
    expect(before[0]?.label).toBe('Wallet 1');
    const set = await setWalletLabel(deps, {
      userId,
      walletAccountId: linked.wallet.walletAccountId,
      label: 'Treasury key',
    });
    expect(set.ok).toBe(true);
    const after = await listWallets(deps, { userId, includeUnlinked: false });
    expect(after[0]?.label).toBe('Treasury key');
    // 404-over-403 for someone else's wallet.
    const bob = await seedUserWithSession(fixture.identity, { handle: 'bob2' });
    const foreign = await setWalletLabel(deps, {
      userId: bob.userId,
      walletAccountId: linked.wallet.walletAccountId,
      label: 'mine now',
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.status).toBe(404);
  });

  it('risk state stays fail-closed pending, then reads through the WS-N seam', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const linked = await linkTestWallet(fixture, userId, 's1');
    if (!linked.ok) throw new Error('link failed');
    const deps = walletDeps(fixture);
    const pending = await walletRiskState(deps, {
      userId,
      walletAccountId: linked.wallet.walletAccountId,
    });
    expect(pending.ok && pending.riskState).toBe('pending');

    // Wire an assessment: the label updates and persists; no internals leak.
    deps.compliance = {
      ...deps.compliance,
      walletRisk: async () => ({
        state: 'elevated',
        explanation: 'Additional review required.',
        nextStep: 'Additional verification required before high-value transfers.',
      }),
    };
    const assessed = await walletRiskState(deps, {
      userId,
      walletAccountId: linked.wallet.walletAccountId,
    });
    expect(assessed.ok && assessed.riskState).toBe('elevated');
    const stored = await fixture.knomosis.wallets.getById(linked.wallet.walletAccountId);
    expect(stored?.riskState).toBe('elevated');
  });

  it('records a link-time `clear` by promoting the wallet out of pending (thread-Y)', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.compliance = {
      ...fixture.knomosis.compliance,
      screenAddress: async () => 'clear',
    };
    const { userId } = await seedUserWithSession(fixture.identity);
    const linked = await linkTestWallet(fixture, userId, 's1');
    if (!linked.ok) throw new Error('link failed');
    // A `clear` verdict at link — the one moment the plaintext address exists —
    // is the ONLY thing that lifts the fail-closed `pending` state, and it does
    // so HERE (recorded on the stored row), not from a later absence of signals.
    expect(linked.wallet.riskState).toBe('normal');
    const stored = await fixture.knomosis.wallets.getById(linked.wallet.walletAccountId);
    expect(stored?.riskState).toBe('normal');
  });

  it('an unscreened link (screening unavailable) is never promoted to normal by an absence-of-signal read-through (thread-Y)', async () => {
    const fixture = await freshKnomosisServices();
    // The default port screens `unavailable` (no provider): the link records no
    // clearance, so the wallet stays fail-closed `pending`.
    const { userId } = await seedUserWithSession(fixture.identity);
    const linked = await linkTestWallet(fixture, userId, 's1');
    if (!linked.ok) throw new Error('link failed');
    expect(linked.wallet.riskState).toBe('pending');

    const deps = walletDeps(fixture);
    // The WS-N engine recovers and reports `normal` — but that is derived from
    // the ABSENCE of pins and cases, which is equally true of a wallet that was
    // NEVER screened.  It must not lift the still-unscreened `pending` wallet
    // (the pre-fix fail-open: a wallet could move funds having never been cleared).
    deps.compliance = {
      ...deps.compliance,
      walletRisk: async () => ({
        state: 'normal',
        explanation: 'No elevated risk signals are associated with this wallet.',
        nextStep: null,
      }),
    };
    const read = await walletRiskState(deps, {
      userId,
      walletAccountId: linked.wallet.walletAccountId,
    });
    expect(read.ok && read.riskState).toBe('pending');
    // The owner-readable copy stays the pending explanation, not "no elevated risk".
    expect(read.ok && read.explanation).toContain('not completed its first risk assessment');
    const stored = await fixture.knomosis.wallets.getById(linked.wallet.walletAccountId);
    expect(stored?.riskState).toBe('pending');

    // …yet a genuine ESCALATION still applies to a pending wallet (strictly more
    // restrictive is always safe).
    deps.compliance = {
      ...deps.compliance,
      walletRisk: async () => ({
        state: 'high',
        explanation: 'This wallet is currently restricted from financial actions pending review.',
        nextStep: 'Contact support to resolve the restriction.',
      }),
    };
    const escalated = await walletRiskState(deps, {
      userId,
      walletAccountId: linked.wallet.walletAccountId,
    });
    expect(escalated.ok && escalated.riskState).toBe('high');
  });

  it('a link-time `blocked` keeps the wallet pending and fires the sanctions hook (thread-Y)', async () => {
    const fixture = await freshKnomosisServices();
    const alerts: string[] = [];
    fixture.knomosis.alert = (event) => alerts.push(event);
    fixture.knomosis.compliance = {
      ...fixture.knomosis.compliance,
      screenAddress: async () => 'blocked',
    };
    const { userId } = await seedUserWithSession(fixture.identity);
    const linked = await linkTestWallet(fixture, userId, 's1');
    if (!linked.ok) throw new Error('link failed');
    // A sanctions hit never promotes out of pending; the operator is alerted.
    expect(linked.wallet.riskState).toBe('pending');
    expect(alerts).toContain('knomosis.wallet.link_sanctioned');
  });

  it('an active pending re-link re-screens so a recovered provider can clear it (thread wallet.ts:308)', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    // First link: the default port screens `unavailable`, so the wallet stays
    // fail-closed `pending` (and the read-through refuses to promote it — thread-Y).
    const first = await linkTestWallet(fixture, userId, 's1');
    if (!first.ok) throw new Error('first link failed');
    expect(first.wallet.riskState).toBe('pending');
    // The provider recovers; a re-link of the SAME active address now screens
    // `clear`.  Without re-screening on the already-linked branch this wallet
    // would be fund-blocked forever (no unlink→finalize→relink), so the re-link
    // must re-run link-time screening.
    fixture.knomosis.compliance = {
      ...fixture.knomosis.compliance,
      screenAddress: async () => 'clear',
    };
    const second = await linkTestWallet(fixture, userId, 's2');
    if (!second.ok) throw new Error('relink failed');
    expect(second.alreadyLinked).toBe(true); // the idempotent active re-link branch
    expect(second.wallet.riskState).toBe('normal'); // …but it re-screened and cleared
    const stored = await fixture.knomosis.wallets.getById(second.wallet.walletAccountId);
    expect(stored?.riskState).toBe('normal');
  });

  it('link attempts are rate-limited and fire an integrity alert (WS-L.2.5d)', async () => {
    const fixture = await freshKnomosisServices();
    const alerts: string[] = [];
    fixture.knomosis.alert = (event) => alerts.push(event);
    const { userId } = await seedUserWithSession(fixture.identity);
    const deps = walletDeps(fixture);
    const limit = fixture.knomosis.config().linkAttemptsPerHour;
    // Burn the budget with garbage attempts (failures still count).
    for (let i = 0; i < limit; i += 1) {
      await linkWallet(deps, {
        userId,
        sessionTokenHash: `s${i}`,
        message: 'garbage',
        signature: `0x${'ab'.repeat(65)}`,
      });
    }
    const over = await linkWallet(deps, {
      userId,
      sessionTokenHash: 'sx',
      message: 'garbage',
      signature: `0x${'ab'.repeat(65)}`,
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.status).toBe(429);
    expect(alerts).toContain('knomosis.wallet.link_rate_exceeded');
  });
});
