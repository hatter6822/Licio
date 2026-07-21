// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U model candidacy + the role split at the SERVICE layer: hub verification
// at propose time (fail-closed `hub_disabled`, typed hub errors, the stored
// snapshot), the per-lane admission pins (moderation sampling + the
// adjudication validity probe), the classify/debateConditioning pin gates over
// a hub selection, and the scheduler's adjudication repin sweep for rows
// admitted before the split.
import type { HubModelRef } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { ModelHubError } from '../ai-governance/model-hub.js';
import type { ModerationProposer } from '../governance/moderation-proposer.js';
import { createGovernanceService } from '../governance/services.js';
import { createInMemoryGovernanceStores } from '../governance/stores.js';

const SHA = 'c'.repeat(40);
const MOD_REF: HubModelRef = {
  source: 'huggingface',
  repoId: 'Qwen/Qwen3Guard-Gen-8B',
  revision: SHA,
};
const ADJ_REF: HubModelRef = { source: 'huggingface', repoId: 'Qwen/Qwen3.6-27B', revision: SHA };

const METADATA = (repoId: string) => ({
  repo_id: repoId,
  revision: SHA,
  pipeline_tag: 'text-generation' as const,
  license: 'apache-2.0',
  parameter_count: 1_000,
  fetched_at: '2026-07-01T00:00:00.000Z',
});

/** A benign-passing LLM-style proposer whose hub resolution is scriptable.
 *  `lanePin.current` models the moderation lane's config-hashed identity (a
 *  lane upgrade changes it); `flipPinDuringSampling` flips a hub pin between
 *  the pre-sampling read and the post-sampling read (the TOCTOU case);
 *  `misclassify.current` makes every verdict `allow` (definitive out-of-band
 *  on the violating fixture). */
function scriptableProposer(
  resolvable: { current: boolean },
  lanePin: { current: string } = { current: 'llm:lane-moderation' },
  options: { flipPinDuringSampling?: boolean; misclassify?: { current: boolean } } = {},
): ModerationProposer {
  let hubPinSuffix = '';
  return {
    kind: 'llm',
    get backendId() {
      return lanePin.current;
    },
    async resolveBackendId(ref) {
      if (ref === null) return lanePin.current;
      return resolvable.current ? `llm:hub-${ref.repoId}${hubPinSuffix}` : null;
    },
    async propose(request) {
      if (request.modelRef !== null && !resolvable.current) {
        return { status: 'unavailable', code: 'room_model_unavailable' };
      }
      if (options.flipPinDuringSampling) hubPinSuffix = ':relocated';
      // In-band on every platform fixture: benign allow, violating flag —
      // unless `misclassify` scripts a blanket allow (out-of-band on the
      // violating fixture ⇒ definitive admission failure).
      const violating =
        !options.misclassify?.current &&
        (request.context.linkCount >= 3 ||
          request.context.priorRemovalsInRoom >= 2 ||
          request.context.contentText.length > 400 ||
          /hurt|attack|scam|kill/i.test(request.context.contentText));
      return {
        status: 'decided',
        proposal: {
          action: violating ? 'flag_for_review' : 'allow',
          reason: 'scripted',
          outputId: null,
        },
      };
    },
  };
}

function make(over: {
  resolvable?: boolean;
  adjudicationOk?: boolean;
  hub?: boolean;
  hubError?: ModelHubError;
  flipPinDuringSampling?: boolean;
  aliases?: ReadonlyMap<string, ReadonlySet<string>>;
}) {
  const resolvable = { current: over.resolvable ?? true };
  const adjudication = { ok: over.adjudicationOk ?? true, probes: 0 };
  const lanePin = { current: 'llm:lane-moderation' };
  const misclassify = { current: false };
  const stores = createInMemoryGovernanceStores();
  let n = 0;
  const svc = createGovernanceService({
    stores,
    now: () => new Date('2026-07-01T00:00:00.000Z'),
    uuid: () => `id-${++n}`,
    moderationProposer: scriptableProposer(resolvable, lanePin, {
      ...(over.flipPinDuringSampling ? { flipPinDuringSampling: true } : {}),
      misclassify,
    }),
    adjudicationBackend: {
      async backendId(ref) {
        if (ref === null) return 'llm:lane-adjudication';
        return resolvable.current ? `llm:hub-adj-${ref.repoId}` : null;
      },
      async probe() {
        adjudication.probes += 1;
        return adjudication.ok ? 'ok' : 'transient';
      },
    },
    ...(over.hub === false
      ? {}
      : {
          modelHub: {
            async verify(ref) {
              if (over.hubError) throw over.hubError;
              return METADATA(ref.repoId);
            },
          },
        }),
    ...(over.aliases ? { hubServedModelAliases: over.aliases } : {}),
  });
  return { svc, stores, resolvable, adjudication, lanePin, misclassify };
}

const bundle = (over: Record<string, unknown> = {}) => ({
  bundleId: 'b',
  version: '1',
  name: 'n',
  moderationPrompt:
    'Route link-heavy, spammy, or otherwise suspicious contributions to human review; allow civil on-topic content.',
  promptTemplates: {},
  config: {},
  requestedCapabilities: ['moderate.flag', 'debate.judge'],
  ...over,
});

describe('candidacy is a MEMBER power (the community authors its own model)', () => {
  it('a non-member cannot propose; any member can (the steward validates, not authors)', async () => {
    const { svc } = make({});
    await svc.bootstrapSeat('r', 's');
    const refused = await svc.proposeModel('r', 'outsider', bundle(), 'p', false);
    expect(!refused.ok && refused.code).toBe('not_member');
    // A plain member (not the seat-holder) proposes successfully.
    const proposed = await svc.proposeModel('r', 'member-1', bundle(), 'p', true);
    expect(proposed.ok).toBe(true);
  });
});

describe('propose-time hub verification (fail-closed)', () => {
  it('a hub-referencing bundle without a verifier is hub_disabled; a plain bundle still proposes', async () => {
    const { svc } = make({ hub: false });
    await svc.bootstrapSeat('r', 's');
    const refused = await svc.proposeModel(
      'r',
      's',
      bundle({ modelSelection: { moderation: MOD_REF } }),
      'p',
      true,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('hub_disabled');
    expect((await svc.proposeModel('r', 's', bundle(), 'p', true)).ok).toBe(true);
  });

  it('typed hub refusals map onto propose errors; a transport fault is retryable hub_unavailable', async () => {
    const cases: Array<[ModelHubError, string]> = [
      [new ModelHubError('not_found', 'x'), 'hub_model_not_found'],
      [new ModelHubError('gated', 'x'), 'hub_model_gated'],
      [new ModelHubError('unsupported_pipeline', 'x'), 'hub_model_unsupported'],
      [new ModelHubError('transport', 'x'), 'hub_unavailable'],
    ];
    for (const [hubError, expected] of cases) {
      const { svc } = make({ hubError });
      await svc.bootstrapSeat('r', 's');
      const result = await svc.proposeModel(
        'r',
        's',
        bundle({ modelSelection: { adjudication: ADJ_REF } }),
        'p',
        true,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(expected);
    }
  });

  it('a servedModelId other than the repo id needs the operator-attested alias (fail-closed)', async () => {
    // Un-attested: a verified benign repo must never label an arbitrary
    // locally-served model in the transparency record.
    const { svc } = make({});
    await svc.bootstrapSeat('r', 's');
    const refused = await svc.proposeModel(
      'r',
      's',
      bundle({ modelSelection: { moderation: { ...MOD_REF, servedModelId: 'other:latest' } } }),
      'p',
      true,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('hub_served_id_not_attested');
    // Spelling out the repo id itself adds nothing — no attestation needed.
    const equal = await svc.proposeModel(
      'r',
      's',
      bundle({ modelSelection: { moderation: { ...MOD_REF, servedModelId: MOD_REF.repoId } } }),
      'p',
      true,
    );
    expect(equal.ok).toBe(true);
    // The operator-attested alias (e.g. an Ollama GGUF re-serve) passes.
    const attested = make({
      aliases: new Map([[MOD_REF.repoId, new Set(['guard-gguf:q8'])]]),
    });
    await attested.svc.bootstrapSeat('r', 's');
    const accepted = await attested.svc.proposeModel(
      'r',
      's',
      bundle({ modelSelection: { moderation: { ...MOD_REF, servedModelId: 'guard-gguf:q8' } } }),
      'p',
      true,
    );
    expect(accepted.ok).toBe(true);
  });

  it('stores the verified per-role snapshots on the model row (transparency)', async () => {
    const { svc, stores } = make({});
    await svc.bootstrapSeat('r', 's');
    const proposed = await svc.proposeModel(
      'r',
      's',
      bundle({ modelSelection: { moderation: MOD_REF, adjudication: ADJ_REF } }),
      'p',
      true,
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const record = await stores.models.get(proposed.value.modelId);
    expect(record?.hubVerification?.moderation?.repo_id).toBe('Qwen/Qwen3Guard-Gen-8B');
    expect(record?.hubVerification?.adjudication?.repo_id).toBe('Qwen/Qwen3.6-27B');
  });
});

describe('per-lane admission pins (the role split)', () => {
  it('pins BOTH lanes on eligibility — the hub selection under its own identity', async () => {
    const { svc, stores } = make({});
    await svc.bootstrapSeat('r', 's');
    const proposed = await svc.proposeModel(
      'r',
      's',
      bundle({ modelSelection: { moderation: MOD_REF } }),
      'p',
      true,
    );
    if (!proposed.ok) throw new Error('propose failed');
    const evaluated = await svc.evaluateModel(proposed.value.modelId);
    expect(evaluated.ok && evaluated.value.status).toBe('eligible');
    const record = await stores.models.get(proposed.value.modelId);
    expect(record?.admittedBackendId).toBe('llm:hub-Qwen/Qwen3Guard-Gen-8B');
    expect(record?.admittedAdjudicationBackendId).toBe('llm:lane-adjudication');
  });

  it('an unresolvable hub selection keeps admission `evaluating` (retryable) and resolves once served', async () => {
    const { svc, stores, resolvable } = make({ resolvable: false });
    await svc.bootstrapSeat('r', 's');
    const proposed = await svc.proposeModel(
      'r',
      's',
      bundle({ modelSelection: { moderation: MOD_REF } }),
      'p',
      true,
    );
    if (!proposed.ok) throw new Error('propose failed');
    const evaluated = await svc.evaluateModel(proposed.value.modelId);
    expect(evaluated.ok && evaluated.value.status).toBe('evaluating');
    // The operator provisions the model; the admission-retry sweep resolves it.
    resolvable.current = true;
    const retried = await svc.reEvaluateStuckAdmissions();
    expect(retried.resolved).toBe(1);
    expect((await stores.models.get(proposed.value.modelId))?.status).toBe('eligible');
  });

  it('a transient adjudication probe keeps a debate.judge bundle `evaluating`; a bundle without the capability never probes', async () => {
    const failing = make({ adjudicationOk: false });
    await failing.svc.bootstrapSeat('r', 's');
    const withDebate = await failing.svc.proposeModel('r', 's', bundle(), 'p', true);
    if (!withDebate.ok) throw new Error('propose failed');
    const evaluated = await failing.svc.evaluateModel(withDebate.value.modelId);
    expect(evaluated.ok && evaluated.value.status).toBe('evaluating');
    expect(failing.adjudication.probes).toBe(1);

    const noDebate = make({ adjudicationOk: false });
    await noDebate.svc.bootstrapSeat('r', 's');
    const modOnly = await noDebate.svc.proposeModel(
      'r',
      's',
      bundle({ requestedCapabilities: ['moderate.flag'] }),
      'p',
      true,
    );
    if (!modOnly.ok) throw new Error('propose failed');
    const ok = await noDebate.svc.evaluateModel(modOnly.value.modelId);
    expect(ok.ok && ok.value.status).toBe('eligible');
    expect(noDebate.adjudication.probes).toBe(0);
  });
});

describe('the live pin gates (fail-closed under drift)', () => {
  async function approvedRoom(h: ReturnType<typeof make>, over: Record<string, unknown> = {}) {
    await h.svc.bootstrapSeat('r', 's');
    const proposed = await h.svc.proposeModel('r', 's', bundle(over), 'p', true);
    if (!proposed.ok) throw new Error('propose failed');
    await h.svc.evaluateModel(proposed.value.modelId);
    const approved = await h.svc.approveModel('r', proposed.value.modelId, null, null);
    if (!approved.ok) throw new Error(`approve failed: ${approved.code}`);
    return proposed.value.modelId;
  }

  it('debateConditioning resolves under a matching adjudication pin and carries the ref; a mismatch resolves null', async () => {
    const h = make({});
    const modelId = await approvedRoom(h, { modelSelection: { adjudication: ADJ_REF } });
    const conditioning = await h.svc.debateConditioning('r');
    expect(conditioning?.adjudicationRef).toEqual(ADJ_REF);
    // The selection stops resolving (runtime lost the model) ⇒ fail closed.
    h.resolvable.current = false;
    expect(await h.svc.debateConditioning('r')).toBeNull();
    h.resolvable.current = true;
    expect((await h.svc.debateConditioning('r'))?.modelId).toBe(modelId);
  });

  it('a legacy row (null adjudication pin) fails closed until the repin sweep heals it', async () => {
    const h = make({});
    const modelId = await approvedRoom(h);
    // Simulate a pre-split row: adjudication pin missing.
    await h.stores.models.patchAdmission(modelId, 'llm:lane-moderation', null);
    expect(await h.svc.debateConditioning('r')).toBeNull();
    const swept = await h.svc.repinAdjudication();
    expect(swept).toEqual({ mismatched: 1, repinned: 1 });
    expect(await h.svc.debateConditioning('r')).not.toBeNull();
    // Idempotent: a matching pin is not re-probed.
    expect(await h.svc.repinAdjudication()).toEqual({ mismatched: 0, repinned: 0 });
  });

  it('agentOperative reflects the moderation pin over a hub selection', async () => {
    const h = make({});
    await approvedRoom(h, { modelSelection: { moderation: MOD_REF } });
    expect(await h.svc.agentOperative('r')).toBe(true);
    h.resolvable.current = false; // hub model no longer served ⇒ not operative
    expect(await h.svc.agentOperative('r')).toBe(false);
  });

  it('a pin that FLIPS mid-sampling keeps admission `evaluating` (the sampling must be attested by the backend that ran it)', async () => {
    const h = make({ flipPinDuringSampling: true });
    await h.svc.bootstrapSeat('r', 's');
    const proposed = await h.svc.proposeModel(
      'r',
      's',
      bundle({ modelSelection: { moderation: MOD_REF } }),
      'p',
      true,
    );
    if (!proposed.ok) throw new Error('propose failed');
    const evaluated = await h.svc.evaluateModel(proposed.value.modelId);
    expect(evaluated.ok && evaluated.value.status).toBe('evaluating'); // retryable, never a wrong pin
  });
});

describe('the moderation re-admission sweep (an approved room survives a lane upgrade)', () => {
  async function approvedPlainRoom(h: ReturnType<typeof make>) {
    await h.svc.bootstrapSeat('r', 's');
    const proposed = await h.svc.proposeModel('r', 's', bundle(), 'p', true);
    if (!proposed.ok) throw new Error('propose failed');
    await h.svc.evaluateModel(proposed.value.modelId);
    const approved = await h.svc.approveModel('r', proposed.value.modelId, null, null);
    if (!approved.ok) throw new Error(`approve failed: ${approved.code}`);
    return proposed.value.modelId;
  }

  it('re-runs the FULL floor evaluation under the new lane and heals the pin without touching the approved status', async () => {
    const h = make({});
    const modelId = await approvedPlainRoom(h);
    expect(await h.svc.agentOperative('r')).toBe(true);
    // The lane upgrades (a new default model mints a new config-hashed pin):
    // the room fails closed…
    h.lanePin.current = 'llm:lane-moderation-v2';
    expect(await h.svc.agentOperative('r')).toBe(false);
    // …until the sweep re-admits it under the live lane.
    const swept = await h.svc.readmitModeration();
    expect(swept).toEqual({ mismatched: 1, readmitted: 1, refused: 0 });
    expect(await h.svc.agentOperative('r')).toBe(true);
    expect((await h.stores.models.get(modelId))?.status).toBe('approved'); // never demoted
    expect((await h.stores.models.get(modelId))?.admittedBackendId).toBe('llm:lane-moderation-v2');
    // Idempotent: a healthy pin is not re-evaluated.
    expect(await h.svc.readmitModeration()).toEqual({ mismatched: 0, readmitted: 0, refused: 0 });
  });

  it('a new lane that FAILS the floor bands is refused — the room stays fail-closed, the pin untouched', async () => {
    const h = make({});
    const modelId = await approvedPlainRoom(h);
    h.lanePin.current = 'llm:lane-moderation-v2';
    h.misclassify.current = true; // the new lane waves the violating fixture through
    const swept = await h.svc.readmitModeration();
    expect(swept).toEqual({ mismatched: 1, readmitted: 0, refused: 1 });
    expect(await h.svc.agentOperative('r')).toBe(false); // still failing closed
    expect((await h.stores.models.get(modelId))?.admittedBackendId).toBe('llm:lane-moderation');
    expect((await h.stores.models.get(modelId))?.status).toBe('approved');
  });
});
