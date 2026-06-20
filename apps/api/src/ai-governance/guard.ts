// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ProhibitedUseGuard service (WS-K.1.1d + WS-K.2.2a, SPEC §24.1/§24.5). Wraps
// the pure decision (@licio/ai-governance evaluateInvocation) with the audit
// trail and counters: a blocked invocation writes an immutable
// BlockedInvocationRecord and increments `ai.invocation.blocked` (by
// prohibition), so the security dashboard can alert on a nonzero
// autonomous-treasury or risk-identity-hiding rate. The guard runs BEFORE any
// model call; `enforce` throws so a prohibited request can never reach a model.
import { randomUUID } from 'node:crypto';
import {
  type AiInvocation,
  type AiProhibition,
  blockedInvocationRecordSchema,
  evaluateInvocation,
  type ProhibitedUseDecision,
} from '@licio/ai-governance';
import type { AiGovernanceMetrics } from './metrics.js';
import type { BlockedInvocationStore } from './stores.js';

export class ProhibitedUseError extends Error {
  readonly prohibition: AiProhibition;
  readonly reason: string;
  constructor(prohibition: AiProhibition, reason: string) {
    super(`prohibited AI use blocked: ${prohibition} (${reason})`);
    this.name = 'ProhibitedUseError';
    this.prohibition = prohibition;
    this.reason = reason;
  }
}

export interface GuardDeps {
  blocked: BlockedInvocationStore;
  metrics: AiGovernanceMetrics;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

export class ProhibitedUseGuard {
  readonly #deps: GuardDeps;
  constructor(deps: GuardDeps) {
    this.#deps = deps;
  }

  /** Evaluate (and audit any block). Returns the allow/block decision. */
  async check(invocation: AiInvocation): Promise<ProhibitedUseDecision> {
    const decision = evaluateInvocation(invocation);
    if (decision.decision === 'block') {
      const record = blockedInvocationRecordSchema.parse({
        block_id: `block:${randomUUID()}`,
        prohibition: decision.prohibition,
        use_case_id: invocation.use_case_id,
        capability: invocation.capability,
        caller: invocation.caller,
        context_ref: invocation.context_ref ?? null,
        reason: decision.reason,
        timestamp: new Date(this.#deps.now()).toISOString(),
      });
      await this.#deps.blocked.put(record);
      this.#deps.metrics.increment('ai.invocation.blocked');
      this.#deps.metrics.increment(`ai.invocation.blocked.${decision.prohibition}`);
      this.#deps.log('ai.invocation.blocked', {
        prohibition: decision.prohibition,
        use_case_id: invocation.use_case_id,
        capability: invocation.capability,
        caller: invocation.caller,
        context_ref: invocation.context_ref ?? null,
      });
    }
    return decision;
  }

  /** Throwing variant: a block raises {@link ProhibitedUseError}. */
  async enforce(invocation: AiInvocation): Promise<void> {
    const decision = await this.check(invocation);
    if (decision.decision === 'block') {
      throw new ProhibitedUseError(decision.prohibition, decision.reason);
    }
  }
}
