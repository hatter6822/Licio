// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Postgres integration tests for the WS-K Drizzle adapters — the
// same interfaces the in-memory adapters satisfy, against the REAL migration
// chain (incl. 0068's ai_review_queue + ai_moderation_decisions).  The first
// leg runs the REAL provisioning (`seedAiGovernance`) against the durable
// stores twice and asserts idempotency — the production first-boot/re-boot
// path.  Run when DATABASE_URL is set (the CI test job provisions the service
// container).
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev pnpm test

import type { AiOutputRecord } from '@licio/ai-governance';
import { createDbClient, migrationsFolder } from '@licio/db';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDrizzleAiGovernanceStores,
  type DrizzleAiGovernanceStores,
} from '../ai-governance/drizzle-ai-governance-stores.js';
import { GOVERNED_MODELS } from '../ai-governance/models.js';
import { seedAiGovernance } from '../ai-governance/seed.js';
import { createInMemoryAiGovernanceServices } from '../ai-governance/services.js';
import { freshEventServices } from './event-test-helpers.js';

const DB_URL = process.env['DATABASE_URL'];
type Db = ReturnType<typeof createDbClient>;

const CONFIG_HASH = 'a'.repeat(64);

function outputRecord(overrides: Partial<AiOutputRecord> = {}): AiOutputRecord {
  return {
    output_id: 'out-1',
    model_name: 'topic-classifier',
    model_version: '1.0.0',
    prompt_template_id: 'tpl-1',
    config_hash: CONFIG_HASH,
    input_refs: ['story-1'],
    output_ref: 'classification-1',
    use_case_id: 'topic_classification',
    correction_ref: null,
    timestamp: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe.skipIf(!DB_URL)('WS-K ai-governance Drizzle adapters (live Postgres)', () => {
  let db: Db;
  let stores: DrizzleAiGovernanceStores;

  const clearAll = async (): Promise<void> => {
    for (const store of Object.values(stores)) await store.clear();
  };

  beforeAll(async () => {
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    stores = createDrizzleAiGovernanceStores(db);
    await clearAll(); // the ai_* tables belong to this suite alone
  });

  afterAll(async () => {
    await clearAll();
    const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await client.end();
  });

  it('provisions the governed models through the REAL gate — idempotently across boots', async () => {
    const { events } = freshEventServices();
    const services = createInMemoryAiGovernanceServices(events);
    // The production boot swap: every store is the Drizzle adapter.
    Object.assign(services, stores);

    await seedAiGovernance(services);

    const deployed = await stores.registry.list({ status: 'deployed' });
    expect(deployed).toHaveLength(GOVERNED_MODELS.length);
    for (const model of GOVERNED_MODELS) {
      const current = await stores.registry.getDeployed(model.name);
      expect(current?.version).toBe(model.version);
      expect(current?.deployed_at).not.toBeNull();
      // The deploy gate's record of truth persisted alongside.
      expect((await stores.evaluations.latest(model.name, model.version))?.decision).toBe('deploy');
    }
    expect(await stores.lineage.get('training-corpus', '1.0.0')).not.toBeNull();
    expect((await stores.riskAssessments.list()).length).toBeGreaterThan(0);
    const inventory = await stores.inventory.latest();
    expect(inventory?.version).toBe(1);

    // Second boot against the SAME durable registry: nothing re-registers, no
    // duplicate evaluations, and the inventory audit trail gains no version.
    await seedAiGovernance(services);
    expect(await stores.registry.list({ status: 'deployed' })).toHaveLength(GOVERNED_MODELS.length);
    const first = GOVERNED_MODELS[0];
    if (!first) throw new Error('GOVERNED_MODELS is empty');
    expect(await stores.evaluations.listByModel(first.name, first.version)).toHaveLength(1);
    expect((await stores.inventory.latest())?.version).toBe(1);

    // Registry filters run against the JSONB card.
    expect((await stores.registry.list({ owner: 'ai-governance' })).length).toBeGreaterThan(0);
    expect(await stores.registry.list({ owner: 'nobody' })).toHaveLength(0);
    // Re-registering an existing (name, version) is refused (append-only).
    const existing = await stores.registry.getVersion(first.name, first.version);
    if (!existing) throw new Error('expected the seeded model to exist');
    expect(await stores.registry.register(existing)).toBeNull();

    // One deployed version per name is STRUCTURAL (migration 0073's partial
    // unique index): promoting a second version without demoting the first is
    // refused by the database, so concurrent deploys can never double-deploy.
    const second = {
      ...existing,
      version: '9.9.9',
      status: 'registered' as const,
      deployed_at: null,
      deprecation: null,
      card: { ...existing.card, version: '9.9.9' },
    };
    expect(await stores.registry.register(second)).not.toBeNull();
    await expect(
      stores.registry.patchStatus(first.name, '9.9.9', {
        status: 'deployed',
        deployed_at: new Date().toISOString(),
        deprecation: null,
      }),
    ).rejects.toThrow();
  });

  it('output records are append-only with the single correction-link mutation', async () => {
    expect(await stores.outputRecords.put(outputRecord())).not.toBeNull();
    expect(await stores.outputRecords.put(outputRecord())).toBeNull(); // dup refused
    expect(
      await stores.outputRecords.put(
        outputRecord({ output_id: 'out-2', timestamp: '2026-07-02T00:00:00.000Z' }),
      ),
    ).not.toBeNull();
    expect(
      await stores.outputRecords.put(
        outputRecord({ output_id: 'out-3', timestamp: '2026-07-05T00:00:00.000Z' }),
      ),
    ).not.toBeNull();

    expect((await stores.outputRecords.get('out-1'))?.output_ref).toBe('classification-1');
    expect(await stores.outputRecords.listByModel('topic-classifier', '1.0.0')).toHaveLength(3);
    // The use-case window is inclusive on both ends.
    const windowed = await stores.outputRecords.listByUseCase(
      'topic_classification',
      '2026-07-01T00:00:00.000Z',
      '2026-07-02T00:00:00.000Z',
    );
    expect(windowed.map((r) => r.output_id)).toEqual(['out-1', 'out-2']);

    const linked = await stores.outputRecords.linkCorrection('out-1', 'corr-1');
    expect(linked?.correction_ref).toBe('corr-1');
    expect(await stores.outputRecords.linkCorrection('missing', 'corr-x')).toBeNull();
  });

  it('corrections list by use case and by output', async () => {
    await stores.corrections.put({
      correction_id: 'corr-1',
      output_id: 'out-1',
      use_case_id: 'topic_classification',
      action: 'modify',
      original_value: 'politics',
      corrected_value: 'economics',
      steward_ref: 'steward:s1',
      category: 'topic',
      corrected_at: '2026-07-03T00:00:00.000Z',
    });
    await stores.corrections.put({
      correction_id: 'corr-2',
      output_id: 'out-2',
      use_case_id: 'topic_classification',
      action: 'confirm',
      original_value: 'politics',
      corrected_value: null,
      steward_ref: 'steward:s2',
      category: null,
      corrected_at: '2026-07-04T00:00:00.000Z',
    });
    expect(await stores.corrections.listByUseCase('topic_classification')).toHaveLength(2);
    const byOutput = await stores.corrections.listByOutput('out-1');
    expect(byOutput).toHaveLength(1);
    expect(byOutput[0]?.corrected_value).toBe('economics');
    expect(byOutput[0]?.category).toBe('topic');
  });

  it('blocked invocations audit newest-first with per-prohibition counts', async () => {
    await stores.blocked.put({
      block_id: 'blk-1',
      prohibition: 'wealth_based_profiling',
      use_case_id: 'topic_classification',
      capability: 'classify_topic',
      caller: 'test',
      context_ref: null,
      reason: 'prohibited input',
      timestamp: '2026-07-01T00:00:00.000Z',
    });
    await stores.blocked.put({
      block_id: 'blk-2',
      prohibition: 'wealth_based_profiling',
      use_case_id: 'topic_classification',
      capability: 'classify_topic',
      caller: 'test',
      context_ref: 'ctx-1',
      reason: 'prohibited input',
      timestamp: '2026-07-02T00:00:00.000Z',
    });
    const listed = await stores.blocked.list(1);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.block_id).toBe('blk-2'); // newest first
    expect(await stores.blocked.countByProhibition()).toEqual({ wealth_based_profiling: 2 });
  });

  it('review queue inserts, filters, and resolves', async () => {
    const item = await stores.reviewQueue.insert({
      kind: 'low_confidence_classification',
      subjectRef: 'story-9',
      context: { confidence: 0.4 },
      status: 'pending',
      resolution: null,
      resolvedBy: null,
    });
    expect(item.reviewId).toMatch(/^airev-/);
    expect((await stores.reviewQueue.get(item.reviewId))?.subjectRef).toBe('story-9');
    expect(
      await stores.reviewQueue.list({ status: 'pending', kind: 'reported_summary' }, 10),
    ).toHaveLength(0);
    expect(
      (await stores.reviewQueue.list({ kind: 'low_confidence_classification' }, 10)).map(
        (r) => r.reviewId,
      ),
    ).toContain(item.reviewId);

    const resolved = await stores.reviewQueue.resolve(
      item.reviewId,
      'confirmed',
      'steward:s1',
      '2026-07-05T00:00:00.000Z',
    );
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolvedAt).toBe('2026-07-05T00:00:00.000Z');
    expect(await stores.reviewQueue.list({ status: 'pending' }, 10)).toHaveLength(0);
    expect(await stores.reviewQueue.resolve('missing', 'x', 'y', new Date().toISOString())).toBe(
      null,
    );
  });

  it('summary drafts upsert and reports aggregate by reason', async () => {
    const draft = {
      summaryId: 'sum-1',
      threadId: 'thread-1',
      draft: { headline: 'v1' },
      outputId: 'out-1',
      qualityPassed: true,
      createdAt: '2026-07-01T00:00:00.000Z',
    };
    await stores.summaries.putDraft(draft);
    await stores.summaries.putDraft({ ...draft, draft: { headline: 'v2' } });
    expect((await stores.summaries.getDraft('sum-1'))?.draft).toEqual({ headline: 'v2' });

    await stores.summaries.putReport({
      report_id: 'srep-1',
      summary_id: 'sum-1',
      reason: 'fake_citation',
      correction_text: null,
      reported_at: '2026-07-02T00:00:00.000Z',
    });
    await stores.summaries.putReport({
      report_id: 'srep-2',
      summary_id: 'sum-1',
      reason: 'fake_citation',
      correction_text: 'cite the actual source',
      reported_at: '2026-07-03T00:00:00.000Z',
    });
    expect(await stores.summaries.listReports('sum-1')).toHaveLength(2);
    expect(await stores.summaries.countReportsByReason()).toEqual({ fake_citation: 2 });
  });

  it('translations upsert, resolve by source, and carry reports', async () => {
    const translation = {
      translation_id: 'tr-1',
      source_kind: 'story' as const,
      source_ref: 'story-1',
      source_lang: 'en',
      target_lang: 'es',
      translated_text: 'hola',
      label: 'AI-translated' as const,
      consistency_passed: true,
      model_name: 'translator',
      model_version: '1.0.0',
      output_id: 'out-2',
      translated_at: '2026-07-01T00:00:00.000Z',
    };
    await stores.translations.put(translation);
    await stores.translations.put({ ...translation, translated_text: 'hola de nuevo' });
    expect((await stores.translations.get('tr-1'))?.translated_text).toBe('hola de nuevo');
    const found = await stores.translations.findBySource('story-1', 'es');
    expect(found?.translation_id).toBe('tr-1');
    expect(found?.label).toBe('AI-translated');
    expect(await stores.translations.findBySource('story-1', 'fr')).toBeNull();

    await stores.translations.putReport({
      report_id: 'trep-1',
      translation_id: 'tr-1',
      reason: 'mistranslation',
      reported_at: '2026-07-02T00:00:00.000Z',
    });
    expect((await stores.translations.listReports('tr-1'))[0]?.reason).toBe('mistranslation');
  });

  it('governance summaries upsert (steward edits) and list by proposal', async () => {
    const summary = {
      summary_id: 'gov-1',
      proposal_ref: 'prop-1',
      cited_fields: ['title', 'body'],
      body: 'A neutral summary of the proposal.',
      material_uncertainty: null,
      uncertainty_flagged: false,
      label: 'machine-generated' as const,
      contestable: true as const,
      steward_edited: false,
      output_id: 'out-3',
      model_name: 'governance-assistant',
      model_version: '1.0.0',
      generated_at: '2026-07-01T00:00:00.000Z',
    };
    await stores.governanceSummaries.put(summary);
    await stores.governanceSummaries.put({ ...summary, steward_edited: true });
    expect((await stores.governanceSummaries.get('gov-1'))?.steward_edited).toBe(true);
    expect(await stores.governanceSummaries.listByProposal('prop-1')).toHaveLength(1);
  });

  it('runtime metrics window since-inclusive and alerts list newest-first', async () => {
    await stores.runtime.recordMetric({
      modelName: 'topic-classifier',
      modelVersion: '1.0.0',
      metric: 'drift',
      value: 0.1,
      recordedAt: '2026-07-01T00:00:00.000Z',
    });
    await stores.runtime.recordMetric({
      modelName: 'topic-classifier',
      modelVersion: '1.0.0',
      metric: 'drift',
      value: 0.4,
      recordedAt: '2026-07-03T00:00:00.000Z',
    });
    const since = await stores.runtime.listMetrics(
      'topic-classifier',
      'drift',
      '2026-07-03T00:00:00.000Z',
    );
    expect(since.map((m) => m.value)).toEqual([0.4]);

    await stores.runtime.recordAlert({
      modelName: 'topic-classifier',
      modelVersion: '1.0.0',
      metric: 'drift',
      value: 0.4,
      threshold: 0.3,
      rollbackRecommendation: null,
      raisedAt: '2026-07-03T01:00:00.000Z',
    });
    const alerts = await stores.runtime.listAlerts(5);
    expect(alerts[0]?.metric).toBe('drift');
    expect(alerts[0]?.rollbackRecommendation).toBeNull();
  });

  it('the WS-U moderation decision log aggregates the wrapper transparency', async () => {
    const base = {
      roomId: 'room-1',
      subjectRef: 'contrib-1',
      outputId: null,
      createdAt: '2026-07-01T00:00:00.000Z',
    };
    await stores.moderationLog.append({
      ...base,
      recordId: 'md-1',
      proposedAction: 'allow',
      boundedAction: 'allow',
      clamped: false,
    });
    await stores.moderationLog.append({
      ...base,
      recordId: 'md-2',
      proposedAction: 'remove',
      boundedAction: 'flag_for_review',
      clamped: true,
      createdAt: '2026-07-02T00:00:00.000Z',
    });
    await stores.moderationLog.append({
      ...base,
      recordId: 'md-3',
      proposedAction: 'warn',
      boundedAction: 'warn',
      clamped: false,
      createdAt: '2026-07-03T00:00:00.000Z',
    });

    const listed = await stores.moderationLog.listByRoom('room-1', 2);
    expect(listed.map((r) => r.recordId)).toEqual(['md-3', 'md-2']); // newest first
    expect(await stores.moderationLog.summaryByRoom('room-1')).toEqual({
      total: 3,
      allowed: 1,
      warned: 1,
      flaggedForReview: 1,
      clampedByWrapper: 1,
    });
    expect(await stores.moderationLog.summaryByRoom('empty-room')).toEqual({
      total: 0,
      allowed: 0,
      warned: 0,
      flaggedForReview: 0,
      clampedByWrapper: 0,
    });
  });
});
