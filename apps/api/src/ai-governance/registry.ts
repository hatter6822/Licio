// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Model registry service (WS-K.1.1b, SPEC §24.2). The deployment chokepoint:
// no model reaches `deployed` without (1) a complete card in the registry, (2) a
// passing harness decision (WS-K.1.2e), and (3) a resolved risk assessment whose
// lineage refs resolve. Old versions are preserved (never overwritten); the
// card's `update_history` is append-only (a new version's history must extend the
// previous version's, verified here). Register/version/deprecate/deploy are
// AI-team only (route guard); lookup is open to any authenticated user.
import {
  isEvaluationComplete,
  type ModelCard,
  modelCardSchema,
  type RegisteredModel,
  registeredModelSchema,
} from '@licio/ai-governance';
import type { AiGovernanceMetrics } from './metrics.js';
import type {
  DataLineageStore,
  EvaluationStore,
  ModelRegistryStore,
  RiskAssessmentStore,
} from './stores.js';

export interface RegistryDeps {
  registry: ModelRegistryStore;
  riskAssessments: RiskAssessmentStore;
  lineage: DataLineageStore;
  evaluations: EvaluationStore;
  metrics: AiGovernanceMetrics;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

export type RegisterOutcome =
  | { ok: true; model: RegisteredModel }
  | {
      ok: false;
      code: 'exists' | 'no_evaluations' | 'risk_assessment_missing' | 'lineage_missing' | 'invalid';
      message: string;
    };

export type VersionOutcome =
  | RegisterOutcome
  | { ok: false; code: 'history_not_appendonly' | 'not_found'; message: string };

export type DeployOutcome =
  | { ok: true; model: RegisteredModel }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'risk_assessment_missing'
        | 'lineage_missing'
        | 'evaluation_missing'
        | 'evaluation_blocked';
      message: string;
    };

async function checkPreconditions(
  deps: RegistryDeps,
  card: ModelCard,
): Promise<{ code: 'risk_assessment_missing' | 'lineage_missing'; message: string } | null> {
  const assessment = await deps.riskAssessments.get(card.risk_assessment_ref);
  if (assessment === null) {
    return {
      code: 'risk_assessment_missing',
      message: `risk assessment "${card.risk_assessment_ref}" does not resolve`,
    };
  }
  const lineage = await deps.lineage.list();
  const datasetIds = new Set(lineage.map((r) => r.dataset_id));
  for (const ref of card.data_lineage_refs) {
    if (!datasetIds.has(ref)) {
      return { code: 'lineage_missing', message: `data lineage ref "${ref}" does not resolve` };
    }
  }
  return null;
}

/** Register a new model with its card (WS-K.1.1b). */
export async function registerModel(
  deps: RegistryDeps,
  cardInput: ModelCard,
): Promise<RegisterOutcome> {
  const cardResult = modelCardSchema.safeParse(cardInput);
  if (!cardResult.success) {
    return {
      ok: false,
      code: 'invalid',
      message: cardResult.error.issues[0]?.message ?? 'invalid card',
    };
  }
  const card = cardResult.data;
  if (card.evaluation_results.length < 1) {
    return {
      ok: false,
      code: 'no_evaluations',
      message: 'registration requires at least one evaluation result',
    };
  }
  const precondition = await checkPreconditions(deps, card);
  if (precondition !== null) return { ok: false, ...precondition };

  const model = registeredModelSchema.parse({
    name: card.name,
    version: card.version,
    card,
    status: 'registered',
    deprecation: null,
    registered_at: new Date(deps.now()).toISOString(),
    deployed_at: null,
  } satisfies RegisteredModel);
  const stored = await deps.registry.register(model);
  if (stored === null) {
    return {
      ok: false,
      code: 'exists',
      message: `model ${card.name}@${card.version} already registered`,
    };
  }
  deps.metrics.increment('ai.model.registered');
  deps.log('model.registered', {
    name: card.name,
    version: card.version,
    evaluation_complete: isEvaluationComplete(card),
  });
  return { ok: true, model: stored };
}

/** Whether `next` history extends `prev` (append-only — prev is a prefix). */
function historyExtends(
  prev: ModelCard['update_history'],
  next: ModelCard['update_history'],
): boolean {
  if (next.length < prev.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    const a = prev[i];
    const b = next[i];
    if (a === undefined || b === undefined) return false;
    if (
      a.version !== b.version ||
      a.date !== b.date ||
      a.description !== b.description ||
      a.evaluation_summary !== b.evaluation_summary
    )
      return false;
  }
  return true;
}

/** Publish a new version of an existing model (WS-K.1.1b). */
export async function versionModel(
  deps: RegistryDeps,
  newCard: ModelCard,
): Promise<VersionOutcome> {
  const existing = await deps.registry.listVersions(newCard.name);
  if (existing.length === 0) {
    return {
      ok: false,
      code: 'not_found',
      message: `no existing version of "${newCard.name}" to supersede`,
    };
  }
  // The append-only update_history: the new card's history must EXTEND the
  // latest existing version's history (no entry modified or deleted, §24.2).
  const latest = existing
    .slice()
    .sort((a, b) => b.registered_at.localeCompare(a.registered_at))[0] as RegisteredModel;
  if (!historyExtends(latest.card.update_history, newCard.update_history)) {
    return {
      ok: false,
      code: 'history_not_appendonly',
      message: 'update_history must extend the previous version (append-only)',
    };
  }
  return registerModel(deps, newCard);
}

/** Look up models (open to all authenticated users); warns on deprecated. */
export async function lookupModels(
  deps: RegistryDeps,
  filter: { name?: string; purpose?: string; owner?: string; status?: RegisteredModel['status'] },
): Promise<RegisteredModel[]> {
  const results = await deps.registry.list(filter);
  for (const model of results) {
    if (model.status === 'deprecated') {
      deps.metrics.increment('ai.model.deprecated_lookup');
      deps.log('model.deprecated.lookup', {
        name: model.name,
        version: model.version,
        recommended_replacement: model.deprecation?.recommended_replacement ?? null,
      });
    }
  }
  return results;
}

/** Deprecate a model version (WS-K.1.1b). Remains queryable for audit. */
export async function deprecateModel(
  deps: RegistryDeps,
  name: string,
  version: string,
  reason: string,
  recommendedReplacement: string | null,
): Promise<{ ok: true; model: RegisteredModel } | { ok: false; message: string }> {
  const model = await deps.registry.getVersion(name, version);
  if (model === null) return { ok: false, message: 'model version not found' };
  const updated = await deps.registry.patchStatus(name, version, {
    status: 'deprecated',
    deployed_at: model.deployed_at,
    deprecation: {
      reason,
      recommended_replacement: recommendedReplacement,
      deprecated_at: new Date(deps.now()).toISOString(),
    },
  });
  if (updated === null) return { ok: false, message: 'deprecation failed' };
  deps.metrics.increment('ai.model.deprecated');
  deps.log('model.deprecated', { name, version, recommended_replacement: recommendedReplacement });
  return { ok: true, model: updated };
}

/**
 * THE DEPLOYMENT GATE (WS-K.1.1b). Promote a version to production only when its
 * card is present, its risk assessment + lineage resolve, and its latest harness
 * decision is `deploy`. Emits `model.deploy.gated` with the gating reason on
 * rejection. Demotes any previously-deployed version of the same name.
 */
export async function deployModel(
  deps: RegistryDeps,
  name: string,
  version: string,
): Promise<DeployOutcome> {
  const model = await deps.registry.getVersion(name, version);
  if (model === null) {
    deps.log('model.deploy.gated', { name, version, reason: 'not_found' });
    return { ok: false, code: 'not_found', message: 'model version not found' };
  }
  const precondition = await checkPreconditions(deps, model.card);
  if (precondition !== null) {
    deps.metrics.increment('ai.model.deploy.gated');
    deps.log('model.deploy.gated', { name, version, reason: precondition.code });
    return { ok: false, ...precondition };
  }
  const decision = await deps.evaluations.latest(name, version);
  if (decision === null) {
    deps.metrics.increment('ai.model.deploy.gated');
    deps.log('model.deploy.gated', { name, version, reason: 'evaluation_missing' });
    return { ok: false, code: 'evaluation_missing', message: 'no harness evaluation on record' };
  }
  if (decision.decision !== 'deploy') {
    deps.metrics.increment('ai.model.deploy.gated');
    deps.log('model.deploy.gated', {
      name,
      version,
      reason: 'evaluation_blocked',
      blocked_reasons: decision.blocked_reasons,
    });
    return {
      ok: false,
      code: 'evaluation_blocked',
      message: `harness blocked deployment: ${decision.blocked_reasons.join('; ')}`,
    };
  }

  // One deployed version per name: demote any prior deployment to registered.
  for (const sibling of await deps.registry.listVersions(name)) {
    if (sibling.status === 'deployed' && sibling.version !== version) {
      await deps.registry.patchStatus(name, sibling.version, {
        status: 'registered',
        deployed_at: null,
        deprecation: sibling.deprecation,
      });
    }
  }
  const deployed = await deps.registry.patchStatus(name, version, {
    status: 'deployed',
    deployed_at: new Date(deps.now()).toISOString(),
    deprecation: model.deprecation,
  });
  if (deployed === null) return { ok: false, code: 'not_found', message: 'deploy patch failed' };
  deps.metrics.increment('ai.model.deployed');
  deps.log('model.deployed', { name, version });
  return { ok: true, model: deployed };
}
