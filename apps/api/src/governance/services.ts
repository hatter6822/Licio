// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U injectable service container + process singleton (the house pattern). The
// in-memory stores back development and tests; the gated Drizzle adapters bind
// the same interfaces in production. The digest is node:crypto SHA-256 (the pure
// @licio/governance package stays I/O-free and receives it injected).

import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_GOVERNANCE_CONFIG, type GovernanceConfig } from './config.js';
import { createDeterministicModerationProposer } from './deterministic-moderation-proposer.js';
import type {
  ModerationDecisionSink,
  ModerationDeferralSink,
  ModerationProposer,
} from './moderation-proposer.js';
import type { GovernanceNlProvider } from './nl-provider.js';
import { GovernanceService, type GovernanceServiceDeps } from './service.js';
import { createInMemoryGovernanceStores, type GovernanceStores } from './stores.js';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export interface GovernanceServiceOptions {
  stores?: GovernanceStores;
  config?: GovernanceConfig;
  /** LIVE crypto-flag reader (boot wires the shared knomosis runtime config); a
   *  runtime disable then stops treasury execution without a reboot. */
  cryptoFlag?: () => boolean;
  now?: () => Date;
  uuid?: () => string;
  /** WS-L.3.5d/e kill-switch guards (boot wires the knomosis registry in). */
  killSwitches?: {
    treasuryExecutionBlocked(roomId: string): Promise<boolean>;
    votingBlocked(roomId: string, voterUserId: string | null): Promise<boolean>;
  };
  /** ADR-3 governed NL provider (boot wires the fail-closed LLM backend when
   *  enabled; absent ⇒ the pure deterministic facilitation path). */
  nlProvider?: GovernanceNlProvider;
  /** ADR-9 in-room moderation model. Boot wires the LLM proposer when a backend
   *  is configured; otherwise this DEFAULTS to the deterministic proposer (the
   *  ADR-3 default), so the feature is operable + testable without an LLM. */
  moderationProposer?: ModerationProposer;
  /** Deferred-remoderation enqueue sink (boot wires the durable queue). */
  onModerationDeferred?: ModerationDeferralSink;
  /** Moderation observability sink (boot wires the decision log). */
  onModerationDecided?: ModerationDecisionSink;
  /** WS-U model candidacy: the propose-time hub verifier (boot wires the
   *  huggingface.co client unless GOVERNANCE_MODEL_HUB=off; absent ⇒
   *  hub-referencing bundles are rejected `hub_disabled`, fail-closed). */
  modelHub?: GovernanceServiceDeps['modelHub'];
  /** Operator-attested served-id aliases (`GOVERNANCE_MODEL_HUB_ALIASES`);
   *  absent ⇒ empty (only repo-id-equal served ids pass propose verification). */
  hubServedModelAliases?: GovernanceServiceDeps['hubServedModelAliases'];
  /** The ADJUDICATION lane's admission pin + validity probe (boot wires it when
   *  the LLM debate adjudicator is enabled; absent ⇒ no adjudication pin is
   *  recorded and the debate-leg pin gate is skipped — the test posture). */
  adjudicationBackend?: GovernanceServiceDeps['adjudicationBackend'];
}

export function createGovernanceService(opts: GovernanceServiceOptions = {}): GovernanceService {
  return new GovernanceService({
    stores: opts.stores ?? createInMemoryGovernanceStores(),
    config: opts.config ?? { ...DEFAULT_GOVERNANCE_CONFIG },
    now: opts.now ?? (() => new Date()),
    uuid: opts.uuid ?? randomUUID,
    digest: sha256Hex,
    // The deterministic proposer is the ADR-3 default; boot overrides it with the
    // LLM proposer when a backend is configured.
    moderationProposer: opts.moderationProposer ?? createDeterministicModerationProposer(),
    ...(opts.cryptoFlag ? { cryptoFlag: opts.cryptoFlag } : {}),
    ...(opts.killSwitches ? { killSwitches: opts.killSwitches } : {}),
    ...(opts.nlProvider ? { nlProvider: opts.nlProvider } : {}),
    ...(opts.onModerationDeferred ? { onModerationDeferred: opts.onModerationDeferred } : {}),
    ...(opts.onModerationDecided ? { onModerationDecided: opts.onModerationDecided } : {}),
    ...(opts.modelHub ? { modelHub: opts.modelHub } : {}),
    ...(opts.hubServedModelAliases ? { hubServedModelAliases: opts.hubServedModelAliases } : {}),
    ...(opts.adjudicationBackend ? { adjudicationBackend: opts.adjudicationBackend } : {}),
  });
}

let singleton: GovernanceService | null = null;

export function getGovernanceService(): GovernanceService {
  if (!singleton) singleton = createGovernanceService();
  return singleton;
}

/**
 * Bind the process singleton (the boot wiring point). Production calls this with
 * a service over the Drizzle stores BEFORE any route/seat-bootstrap touches
 * `getGovernanceService()`, so every later read/write hits the same bound store.
 */
export function setGovernanceService(service: GovernanceService): void {
  singleton = service;
}

/** Test hook: drop the singleton so a fresh in-memory service is built. */
export function resetGovernanceService(): void {
  singleton = null;
}
