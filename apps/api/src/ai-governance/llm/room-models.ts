// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ROOM-MODEL RESOLVER (WS-U model candidacy): turns a room bundle's
// member-selected, revision-pinned hub model reference into a LIVE governed
// completion — or `null` when it cannot, so every caller fails closed
// (admission stays retryable, moderation degrades to the platform baseline +
// deferred re-moderation, the debate leg falls to the deterministic MLP).
// Resolution =
//   1. locate the serving runtime through the loopback runtime catalog
//      (`GET /v1/models` over the lane URLs + the extra runtime URLs);
//   2. mint the model's config-hashed registry identity (the hub revision —
//      immutable on the hub — is the pinned decision surface) and push it
//      through the REAL WS-K register/deploy gate exactly like the platform
//      lane models (`ensureGovernanceLlmDeployed`); a gate refusal resolves
//      null, never a served-but-ungoverned model;
//   3. build (and cache) the loopback completion for the located runtime.
// Hub models are LOCAL-runtime-only by construction: the hosted backend cannot
// serve arbitrary hub weights, so resolution under it is always null.

import type { HubModelRef } from '@licio/shared';
import type { ModelIdentity } from '../models.js';
import type { AiGovernanceServices } from '../services.js';
import type { GovernanceLlmLane, GovernanceLlmRole, GovernanceLlmSettings } from './config.js';
import { type ModerationOutputFormat, resolveModerationOutputFormat } from './guard-format.js';
import { createLocalCompletion, type FetchLike, type LocalCompletionLog } from './local.js';
import type { LlmCompletion } from './provider.js';
import {
  buildRoomHubDebateJudgeIdentity,
  buildRoomHubModerationIdentity,
  ensureGovernanceLlmDeployed,
  llmBackendId,
} from './registration.js';
import type { RuntimeCatalog } from './runtime-catalog.js';

/** A hub reference resolved to a live, WS-K-deployed governed completion. */
export interface ResolvedRoomModel {
  complete: LlmCompletion;
  settings: GovernanceLlmSettings;
  identity: ModelIdentity;
  /** The admission pin (`llm:<identity name>`) — what `evaluateModel` records
   *  and the live surfaces compare before running under this model. */
  backendId: string;
  /** The completion dialect (guard-family hub models auto-detect). */
  format: ModerationOutputFormat;
}

export interface RoomModelResolver {
  resolveModeration(ref: HubModelRef): Promise<ResolvedRoomModel | null>;
  resolveAdjudication(ref: HubModelRef): Promise<ResolvedRoomModel | null>;
}

export interface RoomModelResolverDeps {
  services: AiGovernanceServices;
  catalog: RuntimeCatalog;
  lanes: { moderation: GovernanceLlmLane; adjudication: GovernanceLlmLane };
  fetchImpl?: FetchLike;
  log?: LocalCompletionLog;
}

/** How long a WS-K gate refusal for a hub identity is remembered before the
 *  deploy is retried (a transient registry/store fault must not permanently
 *  strand a ratified model; `ensureGovernanceLlmDeployed` is idempotent). */
const DEPLOY_RETRY_COOLDOWN_MS = 60_000;

export function createRoomModelResolver(deps: RoomModelResolverDeps): RoomModelResolver {
  const log = deps.log ?? (() => {});
  const completions = new Map<string, LlmCompletion>();
  const deployedOk = new Set<string>();
  const deployFailedAtMs = new Map<string, number>();

  const completionFor = (baseUrl: string, settings: GovernanceLlmSettings): LlmCompletion => {
    const key = `${baseUrl}\u0000${settings.modelId}\u0000${settings.reasoningEffort ?? ''}`;
    const cached = completions.get(key);
    if (cached) return cached;
    const built = createLocalCompletion(baseUrl, settings, deps.fetchImpl ?? fetch, log);
    completions.set(key, built);
    return built;
  };

  const ensureDeployed = async (identity: ModelIdentity): Promise<boolean> => {
    if (deployedOk.has(identity.name)) return true;
    const failedAt = deployFailedAtMs.get(identity.name);
    if (failedAt !== undefined && deps.services.now() - failedAt < DEPLOY_RETRY_COOLDOWN_MS) {
      return false;
    }
    // FIRE-SAFE: a registry/store fault during the gate run is an unresolvable
    // model (cooldown + retry), never a throw — the callers (the moderation
    // proposer's `propose`, the debate judge) contractually never throw.
    let ok = false;
    try {
      ok = await ensureGovernanceLlmDeployed(deps.services, identity);
    } catch (error) {
      log('ai.llm.room_model.deploy_errored', {
        identity: identity.name,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
    if (ok) {
      deployedOk.add(identity.name);
      deployFailedAtMs.delete(identity.name);
    } else {
      deployFailedAtMs.set(identity.name, deps.services.now());
      log('ai.llm.room_model.deploy_refused', { identity: identity.name });
    }
    return ok;
  };

  const resolve = async (
    role: GovernanceLlmRole,
    ref: HubModelRef,
  ): Promise<ResolvedRoomModel | null> => {
    const lane = role === 'moderation' ? deps.lanes.moderation : deps.lanes.adjudication;
    // Hub models are local-runtime-only: the hosted backend cannot serve them.
    if (lane.backend.kind !== 'local') return null;
    const wantedId = ref.servedModelId ?? ref.repoId;
    const located = await deps.catalog.locate(wantedId);
    if (located === null) return null;
    const settings: GovernanceLlmSettings = { ...lane.settings, modelId: located.servedModelId };
    // Guard-family detection keys on the CANONICAL repo id and the served id
    // (a GGUF re-serve keeps the family name in either), moderation role only.
    const format: ModerationOutputFormat =
      role === 'moderation' &&
      [ref.repoId, wantedId].some((id) => resolveModerationOutputFormat(id) === 'qwen3guard')
        ? 'qwen3guard'
        : 'json';
    const identity =
      role === 'moderation'
        ? buildRoomHubModerationIdentity(settings, ref, format)
        : buildRoomHubDebateJudgeIdentity(settings, ref);
    if (!(await ensureDeployed(identity))) return null;
    return {
      complete: completionFor(located.baseUrl, settings),
      settings,
      identity,
      backendId: llmBackendId(identity),
      format,
    };
  };

  return {
    resolveModeration: (ref) => resolve('moderation', ref),
    resolveAdjudication: (ref) => resolve('adjudication', ref),
  };
}
