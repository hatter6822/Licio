// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2 wallet routes (SPEC §23.4): POST /wallet/nonce, POST /wallet/link,
// POST /wallet/unlink/request, GET /wallets, PATCH /wallets/:id (label),
// GET /wallets/:id/risk-state.
//
// Guard order on every route: session auth → verified account → ADULT age
// gate (WS-D.1.7c: financial surfaces fail closed on unknown age) → step-up
// assurance on mutations.  Every route is additionally gated by the runtime
// crypto flag (fail-closed 503 when off — visible unavailability, §17.1
// boundary 3) and the wallet-connection kill switch (WS-L.3.5a).  All routes
// are CSRF-protected (session-bearing browser flows keep the double-submit
// token; no new exemptions).

import {
  uuidSchema,
  WALLET_UNLINK_OBLIGATIONS_MAX,
  walletLabelRequestSchema,
  walletLinkRequestSchema,
  walletLinkResponseSchema,
  walletListQuerySchema,
  walletListResponseSchema,
  walletNonceResponseSchema,
  walletRiskStateResponseSchema,
  walletUnlinkAcceptedSchema,
  walletUnlinkBlockedSchema,
  walletUnlinkRequestSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  buildSanctionedWalletLinkHook,
  complianceServicesConfigured,
  getComplianceServices,
} from '../compliance/services.js';
import { killSwitchDecision } from '../knomosis/killswitch.js';
import { KNOMOSIS_PIN } from '../knomosis/pin.js';
import { getKnomosisServices, type KnomosisServices } from '../knomosis/services.js';
import {
  issueWalletLinkNonce,
  linkWallet,
  listWallets,
  requestUnlink,
  setWalletLabel,
  toWalletSummary,
  type WalletServiceDeps,
  walletRiskState,
} from '../knomosis/wallet.js';
import { zValidator } from '../lib/validate.js';
import {
  type AuthEnv,
  authMiddleware,
  requireAdult,
  requireAuth,
  requireStepUp,
  requireVerifiedAccount,
} from '../middleware/auth.js';

const deny = (code: string, message: string) => ({ error: { code, message } });

/** Build the wallet-service dependency bundle over the container. */
function walletDeps(services: KnomosisServices): WalletServiceDeps {
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
    // A wallet may be linked on the Knomosis L2 (`chain_id`) OR its L1 settlement
    // chain (`l1_chain_id`, where bridge deposits/withdrawals live), so both join the
    // SIWE allowlist (WS-L.2.5a).  Deduped across active deployments.
    chainAllowlist: () => [
      ...new Set(
        KNOMOSIS_PIN.deployments
          .filter((d) => d.status === 'active')
          .flatMap((d) => [d.chain_id, d.l1_chain_id]),
      ),
    ],
    contractVerifier: services.contractSiweVerifier,
    config: services.config,
    now: services.now,
    uuid: services.uuid,
    log: services.log,
    alert: services.alert,
    // WS-N.2.2a: a FULL sanctions match at link pins the wallet high + opens
    // a critical case.  Absent compliance services (bare test containers) the
    // wallet simply stays `pending` — fail-closed, it cannot move funds.
    onSanctionedWalletLink: complianceServicesConfigured()
      ? buildSanctionedWalletLinkHook(getComplianceServices())
      : undefined,
  };
}

/**
 * The base availability gate every wallet route passes FIRST: the crypto flag
 * (off ⇒ 503 with a clear, non-hidden reason) and the wallet-connection kill
 * switch (WS-L.3.5a: 503, immediate effect).  Nothing here bars a member from
 * MANAGING or SEVERING a wallet they already linked.
 */
async function walletBaseGate(
  services: KnomosisServices,
  userId: string,
): Promise<{ code: WalletGateCode } | null> {
  if (!services.config().cryptoEnabled) return { code: 'crypto_disabled' };
  const region = await services.regionResolver.regionForUser(userId);
  const decision = await killSwitchDecision(services.configStore, 'wallet_connection', {
    region,
  });
  if (decision.engaged) return { code: 'wallet_disabled' };
  return null;
}

/**
 * The FULL gate for a NEW connection (nonce/link): the base checks PLUS the
 * region's §22.2 `wallet_connection` verdict (WS-N.1.1c).
 *
 * The jurisdiction leg is not optional decoration: `/compliance/availability`
 * reports `wallet_connection` per the region's policy, and without this check
 * these routes would go on issuing nonces and linking wallets in a region whose
 * policy disables the cell — the platform telling the member the feature is
 * unavailable while handing it to them anyway.  An ordinary `unknown` (no
 * verified declaration, no locale) does NOT bar it: linking a wallet moves no
 * money, and the region ladder is fail-closed for real funds, not for every
 * affordance (the shipped testnet posture).  But a region resolution that FAILED
 * — a declaration-store outage — is NOT an ordinary `unknown`: `resolveRegion`
 * marks it `unavailable` and the engine returns `blocked`, so a member whose
 * verified declaration names a BLOCKED region cannot link a new wallet while the
 * store is down (the escape closed with the outage's fail-closed path).
 *
 * It applies ONLY to new connections.  A region that bars new links must NOT
 * trap the wallet a member linked before the policy changed: they must still be
 * able to list it and — the point of the affordance — UNLINK it.  Those routes
 * pass `walletBaseGate` instead (blocking a region cannot strand a member's
 * existing financial-wallet association until the jurisdiction re-opens).
 */
async function walletGate(
  services: KnomosisServices,
  userId: string,
): Promise<{ code: WalletGateCode } | null> {
  const base = await walletBaseGate(services, userId);
  if (base !== null) return base;
  const region = await services.regionResolver.regionForUser(userId);
  const jurisdiction = await services.compliance.jurisdiction({
    userId,
    region,
    featureCell: 'wallet_connection',
    // Linking moves no asset — the governance signatures are the other callers
    // that name none.
    asset: null,
  });
  if (jurisdiction === 'blocked') return { code: 'wallet_region_blocked' };
  return null;
}

type WalletGateCode = 'crypto_disabled' | 'wallet_disabled' | 'wallet_region_blocked';

const GATE_MESSAGES: Record<WalletGateCode, string> = {
  crypto_disabled: 'Wallet and crypto features are not enabled.',
  wallet_disabled: 'Wallet connection is temporarily disabled.',
  wallet_region_blocked: 'Wallet connection is not available in your region.',
};

export function createWalletRoutes() {
  return (
    new Hono<AuthEnv>()
      // --- POST /wallet/nonce (WS-L.2.3a) --------------------------------
      .post(
        '/wallet/nonce',
        authMiddleware(),
        requireVerifiedAccount(),
        requireAdult(),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          const gate = await walletGate(services, auth.userId);
          if (gate) return c.json(deny(gate.code, GATE_MESSAGES[gate.code]), 503);
          const result = await issueWalletLinkNonce(walletDeps(services), {
            userId: auth.userId,
            sessionTokenHash: auth.tokenHash,
          });
          if (!result.ok) return c.json(deny(result.code, result.message), result.status);
          return c.json(
            walletNonceResponseSchema.parse({
              nonce: result.nonce,
              issued_at: result.issuedAt,
              expires_at: result.expiresAt,
            }),
          );
        },
      )

      // --- POST /wallet/link (WS-L.2.5a) ---------------------------------
      .post(
        '/wallet/link',
        authMiddleware(),
        requireVerifiedAccount(),
        requireAdult(),
        requireStepUp(),
        zValidator('json', walletLinkRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          const gate = await walletGate(services, auth.userId);
          if (gate) return c.json(deny(gate.code, GATE_MESSAGES[gate.code]), 503);
          const body = c.req.valid('json');
          const result = await linkWallet(walletDeps(services), {
            userId: auth.userId,
            sessionTokenHash: auth.tokenHash,
            message: body.message,
            signature: body.signature,
            label: body.label,
          });
          if (!result.ok) return c.json(deny(result.code, result.message), result.status);
          const ordinal = (await services.wallets.listByUser(auth.userId, false)).findIndex(
            (w) => w.walletAccountId === result.wallet.walletAccountId,
          );
          return c.json(
            walletLinkResponseSchema.parse({
              wallet: toWalletSummary(result.wallet, ordinal + 1),
              already_linked: result.alreadyLinked,
            }),
            result.alreadyLinked ? 200 : 201,
          );
        },
      )

      // --- POST /wallet/unlink/request (WS-L.2.5b) ------------------------
      .post(
        '/wallet/unlink/request',
        authMiddleware(),
        requireVerifiedAccount(),
        requireAdult(),
        requireStepUp(),
        zValidator('json', walletUnlinkRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          // SEVER: a member must be able to unlink a wallet they already linked
          // even from a region that now bars new connections (base gate only).
          const gate = await walletBaseGate(services, auth.userId);
          if (gate) return c.json(deny(gate.code, GATE_MESSAGES[gate.code]), 503);
          const body = c.req.valid('json');
          const result = await requestUnlink(walletDeps(services), {
            userId: auth.userId,
            walletAccountId: body.wallet_account_id,
          });
          if ('blocked' in result) {
            // Cap the inline list at the schema max; a wallet with a very large
            // number of open obligations must still yield a usable 409, not a
            // schema exception → 500.  `total_obligations` keeps the count honest.
            return c.json(
              walletUnlinkBlockedSchema.parse({
                error: {
                  code: 'unlink_blocked',
                  message: 'This wallet has unresolved obligations.',
                },
                blocking_obligations: result.obligations.slice(0, WALLET_UNLINK_OBLIGATIONS_MAX),
                total_obligations: result.obligations.length,
              }),
              409,
            );
          }
          if (!result.ok) return c.json(deny(result.code, result.message), result.status);
          return c.json(
            walletUnlinkAcceptedSchema.parse({
              wallet_account_id: result.wallet.walletAccountId,
              unlink_state: 'pending_unlink',
              finalize_after: result.finalizeAfter,
            }),
          );
        },
      )

      // --- GET /wallets (WS-L.2.5c) ---------------------------------------
      .get(
        '/wallets',
        authMiddleware(),
        requireVerifiedAccount(),
        requireAdult(),
        zValidator('query', walletListQuerySchema),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          // LIST: an existing wallet stays visible under a region block (base
          // gate only) — a member cannot manage what they cannot see.
          const gate = await walletBaseGate(services, auth.userId);
          if (gate) return c.json(deny(gate.code, GATE_MESSAGES[gate.code]), 503);
          const query = c.req.valid('query');
          const items = await listWallets(walletDeps(services), {
            userId: auth.userId,
            includeUnlinked: query.include_unlinked === 'true',
          });
          return c.json(walletListResponseSchema.parse({ items, nextCursor: null }));
        },
      )

      // --- PATCH /wallets/:walletId (label; WS-L.2.5c) ---------------------
      .patch(
        '/wallets/:walletId',
        authMiddleware(),
        requireVerifiedAccount(),
        requireAdult(),
        // A label mutation persists financial-wallet metadata + an audit entry, so
        // it requires the SAME fresh step-up assurance as link/unlink (WS-L.2.5c).
        requireStepUp(),
        zValidator('param', z.object({ walletId: uuidSchema })),
        zValidator('json', walletLabelRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          // MANAGE (relabel): metadata on an existing wallet, available under a
          // region block (base gate only).
          const gate = await walletBaseGate(services, auth.userId);
          if (gate) return c.json(deny(gate.code, GATE_MESSAGES[gate.code]), 503);
          const result = await setWalletLabel(walletDeps(services), {
            userId: auth.userId,
            walletAccountId: c.req.valid('param').walletId,
            label: c.req.valid('json').label,
          });
          if (!result.ok) return c.json(deny(result.code, result.message), result.status);
          const ordinal = (await services.wallets.listByUser(auth.userId, true)).findIndex(
            (w) => w.walletAccountId === result.wallet.walletAccountId,
          );
          return c.json({ wallet: toWalletSummary(result.wallet, ordinal + 1) });
        },
      )

      // --- GET /wallets/:walletId/risk-state (WS-L.2.5c-1) -----------------
      .get(
        '/wallets/:walletId/risk-state',
        authMiddleware(),
        requireVerifiedAccount(),
        requireAdult(),
        zValidator('param', z.object({ walletId: uuidSchema })),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          // READ risk-state: available under a region block (base gate only) —
          // a member must be able to see why their existing wallet is flagged.
          const gate = await walletBaseGate(services, auth.userId);
          if (gate) return c.json(deny(gate.code, GATE_MESSAGES[gate.code]), 503);
          const walletId = c.req.valid('param').walletId;
          const result = await walletRiskState(walletDeps(services), {
            userId: auth.userId,
            walletAccountId: walletId,
          });
          if (!result.ok) return c.json(deny(result.code, result.message), result.status);
          return c.json(
            walletRiskStateResponseSchema.parse({
              wallet_account_id: walletId,
              risk_state: result.riskState,
              explanation: result.explanation,
              next_step: result.nextStep,
            }),
          );
        },
      )
  );
}

export type WalletRoutes = ReturnType<typeof createWalletRoutes>;
