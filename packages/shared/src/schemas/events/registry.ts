// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Topic registry (WS-E.1.1g) — the single source of truth mapping every event
// topic to its schema, privacy classification, retention tier, and Knomosis
// flag. Consumed by ingestion, storage, retention jobs, and the consumer router
// (WS-E.1.5), so schema / classification / retention can never drift apart. The
// discriminated union rejects unknown or forged `event_type` values at the
// boundary rather than silently routing them.
import { z } from 'zod';
import {
  attentionAggregateEventSchema,
  contentSavedAggregateEventSchema,
  sourceOpenedAggregateEventSchema,
} from './attention.js';
import {
  contentNormalizedEventSchema,
  contentSubmittedEventSchema,
  contentVisibilityChangedEventSchema,
} from './content.js';
import {
  claimUpdatedEventSchema,
  contributionCreatedEventSchema,
  evidenceAddedEventSchema,
} from './contribution.js';
import {
  EVENT_SCHEMA_VERSION,
  eventEnvelopeSchema,
  type PrivacyClassification,
} from './envelope.js';
import { KNOMOSIS_EVENT_SCHEMAS, type KnomosisTopic } from './knomosis/index.js';
import {
  integritySignalDetectedEventSchema,
  moderationCaseCreatedEventSchema,
} from './moderation.js';
import type { RetentionTier } from './retention.js';
import {
  invariantRunCompletedEventSchema,
  notificationSentEventSchema,
  privacyRequestCreatedEventSchema,
  rankingDecisionLoggedEventSchema,
  threadStateChangedEventSchema,
} from './system.js';

/** The sixteen core (non-Knomosis) topics (SPEC §21.3; WS-Q.1.7a added
 *  `content.visibility.changed`; the §5.3 "Save for later" signal added
 *  `content.saved`). */
export const CORE_EVENT_SCHEMAS = {
  'content.submitted': contentSubmittedEventSchema,
  'content.normalized': contentNormalizedEventSchema,
  'content.visibility.changed': contentVisibilityChangedEventSchema,
  'source.opened.aggregate': sourceOpenedAggregateEventSchema,
  'content.saved': contentSavedAggregateEventSchema,
  'attention.aggregate': attentionAggregateEventSchema,
  'contribution.created': contributionCreatedEventSchema,
  'evidence.added': evidenceAddedEventSchema,
  'claim.updated': claimUpdatedEventSchema,
  'thread.state.changed': threadStateChangedEventSchema,
  'moderation.case.created': moderationCaseCreatedEventSchema,
  'integrity.signal.detected': integritySignalDetectedEventSchema,
  'invariant.run.completed': invariantRunCompletedEventSchema,
  'ranking.decision.logged': rankingDecisionLoggedEventSchema,
  'notification.sent': notificationSentEventSchema,
  'privacy.request.created': privacyRequestCreatedEventSchema,
} as const;

export type CoreTopic = keyof typeof CORE_EVENT_SCHEMAS;
export const CORE_TOPICS = Object.keys(CORE_EVENT_SCHEMAS) as readonly CoreTopic[];

/** Every registered topic name (core + Knomosis). */
export type EventTopic = CoreTopic | KnomosisTopic;

/**
 * The discriminated union over every registered topic. Parses any valid event;
 * rejects unknown `event_type` values, unknown keys (every member is strict),
 * and misclassification (classification/tier are per-topic literals).
 */
export const licioEventSchema = z.discriminatedUnion('event_type', [
  contentSubmittedEventSchema,
  contentNormalizedEventSchema,
  contentVisibilityChangedEventSchema,
  sourceOpenedAggregateEventSchema,
  contentSavedAggregateEventSchema,
  attentionAggregateEventSchema,
  contributionCreatedEventSchema,
  evidenceAddedEventSchema,
  claimUpdatedEventSchema,
  threadStateChangedEventSchema,
  moderationCaseCreatedEventSchema,
  integritySignalDetectedEventSchema,
  invariantRunCompletedEventSchema,
  rankingDecisionLoggedEventSchema,
  notificationSentEventSchema,
  privacyRequestCreatedEventSchema,
  KNOMOSIS_EVENT_SCHEMAS['wallet.link.requested'],
  KNOMOSIS_EVENT_SCHEMAS['wallet.linked'],
  KNOMOSIS_EVENT_SCHEMAS['payment.intent.created'],
  KNOMOSIS_EVENT_SCHEMAS['payment.intent.failed'],
  KNOMOSIS_EVENT_SCHEMAS['payment.receipt.indexed'],
  KNOMOSIS_EVENT_SCHEMAS['room.governance.mode.changed'],
  KNOMOSIS_EVENT_SCHEMAS['governance.proposal.created'],
  KNOMOSIS_EVENT_SCHEMAS['governance.signature.recorded'],
  KNOMOSIS_EVENT_SCHEMAS['governance.proposal.executed'],
  KNOMOSIS_EVENT_SCHEMAS['governance.proposal.challenged'],
  KNOMOSIS_EVENT_SCHEMAS['treasury.deposit.indexed'],
  KNOMOSIS_EVENT_SCHEMAS['treasury.grant.approved'],
  KNOMOSIS_EVENT_SCHEMAS['treasury.payout.executed'],
  KNOMOSIS_EVENT_SCHEMAS['knomosis.action.preflighted'],
  KNOMOSIS_EVENT_SCHEMAS['knomosis.action.submitted'],
  KNOMOSIS_EVENT_SCHEMAS['knomosis.event.indexed'],
  KNOMOSIS_EVENT_SCHEMAS['compliance.financial.case.created'],
  KNOMOSIS_EVENT_SCHEMAS['jurisdiction.feature.disabled'],
]);
export type LicioEvent = z.infer<typeof licioEventSchema>;

/** One registry entry per topic (WS-E.1.1g). */
export interface TopicRegistryEntry {
  /** The full topic schema (strict; envelope + topic fields). */
  schema: z.ZodType<LicioEvent>;
  privacy_classification: PrivacyClassification;
  retention_tier: RetentionTier;
  /** True ⇒ behind the crypto flag and firewalled from scoring (WS-E.1.2). */
  knomosis: boolean;
  since_version: string;
}

function entry(
  schema: z.ZodType<LicioEvent>,
  privacy_classification: PrivacyClassification,
  retention_tier: RetentionTier,
  knomosis: boolean,
): TopicRegistryEntry {
  return {
    schema,
    privacy_classification,
    retention_tier,
    knomosis,
    since_version: EVENT_SCHEMA_VERSION,
  };
}

/**
 * The topic registry. The classification/tier values here are asserted against
 * each schema's own literals in __tests__/events-registry.test.ts (one sample
 * event per topic round-trips and must match), so registry and schema cannot
 * drift.
 */
export const TOPIC_REGISTRY: Readonly<Record<EventTopic, TopicRegistryEntry>> = {
  'content.submitted': entry(contentSubmittedEventSchema, 'public', 'public_contribution', false),
  'content.normalized': entry(contentNormalizedEventSchema, 'public', 'public_contribution', false),
  // WS-Q.1.7a — the topic's BASE classification is `public` (a public sample
  // round-trips against it); a `room_only` content event carries `restricted`
  // and the router's per-event check withholds it from public-only consumers.
  'content.visibility.changed': entry(
    contentVisibilityChangedEventSchema,
    'public',
    'public_contribution',
    false,
  ),
  'source.opened.aggregate': entry(
    sourceOpenedAggregateEventSchema,
    'aggregated',
    'attention_aggregated',
    false,
  ),
  'content.saved': entry(
    contentSavedAggregateEventSchema,
    'aggregated',
    'attention_aggregated',
    false,
  ),
  'attention.aggregate': entry(
    attentionAggregateEventSchema,
    'aggregated',
    'attention_aggregated',
    false,
  ),
  'contribution.created': entry(
    contributionCreatedEventSchema,
    'public',
    'public_contribution',
    false,
  ),
  'evidence.added': entry(evidenceAddedEventSchema, 'public', 'public_contribution', false),
  'claim.updated': entry(claimUpdatedEventSchema, 'public', 'public_contribution', false),
  'thread.state.changed': entry(threadStateChangedEventSchema, 'sensitive', 'ranking_log', false),
  'moderation.case.created': entry(
    moderationCaseCreatedEventSchema,
    'restricted',
    'moderation_legal',
    false,
  ),
  'integrity.signal.detected': entry(
    integritySignalDetectedEventSchema,
    'restricted',
    'security_log',
    false,
  ),
  'invariant.run.completed': entry(
    invariantRunCompletedEventSchema,
    'sensitive',
    'ranking_log',
    false,
  ),
  'ranking.decision.logged': entry(
    rankingDecisionLoggedEventSchema,
    'sensitive',
    'ranking_log',
    false,
  ),
  'notification.sent': entry(notificationSentEventSchema, 'sensitive', 'account_active', false),
  'privacy.request.created': entry(
    privacyRequestCreatedEventSchema,
    'sensitive',
    'account_active',
    false,
  ),
  'wallet.link.requested': entry(
    KNOMOSIS_EVENT_SCHEMAS['wallet.link.requested'],
    'restricted',
    'account_active',
    true,
  ),
  'wallet.linked': entry(
    KNOMOSIS_EVENT_SCHEMAS['wallet.linked'],
    'restricted',
    'account_active',
    true,
  ),
  'payment.intent.created': entry(
    KNOMOSIS_EVENT_SCHEMAS['payment.intent.created'],
    'restricted',
    'security_log',
    true,
  ),
  'payment.intent.failed': entry(
    KNOMOSIS_EVENT_SCHEMAS['payment.intent.failed'],
    'restricted',
    'security_log',
    true,
  ),
  'payment.receipt.indexed': entry(
    KNOMOSIS_EVENT_SCHEMAS['payment.receipt.indexed'],
    'restricted',
    'security_log',
    true,
  ),
  'room.governance.mode.changed': entry(
    KNOMOSIS_EVENT_SCHEMAS['room.governance.mode.changed'],
    'sensitive',
    'account_active',
    true,
  ),
  'governance.proposal.created': entry(
    KNOMOSIS_EVENT_SCHEMAS['governance.proposal.created'],
    'sensitive',
    'account_active',
    true,
  ),
  'governance.signature.recorded': entry(
    KNOMOSIS_EVENT_SCHEMAS['governance.signature.recorded'],
    'sensitive',
    'account_active',
    true,
  ),
  'governance.proposal.executed': entry(
    KNOMOSIS_EVENT_SCHEMAS['governance.proposal.executed'],
    'sensitive',
    'account_active',
    true,
  ),
  'governance.proposal.challenged': entry(
    KNOMOSIS_EVENT_SCHEMAS['governance.proposal.challenged'],
    'sensitive',
    'account_active',
    true,
  ),
  'treasury.deposit.indexed': entry(
    KNOMOSIS_EVENT_SCHEMAS['treasury.deposit.indexed'],
    'restricted',
    'security_log',
    true,
  ),
  'treasury.grant.approved': entry(
    KNOMOSIS_EVENT_SCHEMAS['treasury.grant.approved'],
    'restricted',
    'security_log',
    true,
  ),
  'treasury.payout.executed': entry(
    KNOMOSIS_EVENT_SCHEMAS['treasury.payout.executed'],
    'restricted',
    'security_log',
    true,
  ),
  'knomosis.action.preflighted': entry(
    KNOMOSIS_EVENT_SCHEMAS['knomosis.action.preflighted'],
    'sensitive',
    'account_active',
    true,
  ),
  'knomosis.action.submitted': entry(
    KNOMOSIS_EVENT_SCHEMAS['knomosis.action.submitted'],
    'sensitive',
    'account_active',
    true,
  ),
  'knomosis.event.indexed': entry(
    KNOMOSIS_EVENT_SCHEMAS['knomosis.event.indexed'],
    'sensitive',
    'account_active',
    true,
  ),
  'compliance.financial.case.created': entry(
    KNOMOSIS_EVENT_SCHEMAS['compliance.financial.case.created'],
    'restricted',
    'moderation_legal',
    true,
  ),
  'jurisdiction.feature.disabled': entry(
    KNOMOSIS_EVENT_SCHEMAS['jurisdiction.feature.disabled'],
    'sensitive',
    'security_log',
    true,
  ),
};

/** Every registered topic name. */
export const ALL_EVENT_TOPICS = Object.keys(TOPIC_REGISTRY) as readonly EventTopic[];

/** Whether `topic` is registered at all. */
export function isRegisteredTopic(topic: string): topic is EventTopic {
  return Object.hasOwn(TOPIC_REGISTRY, topic);
}

/** Whether `topic` is a Knomosis (pay-to-rank-firewalled) topic. */
export function isKnomosisTopic(topic: string): boolean {
  return isRegisteredTopic(topic) && TOPIC_REGISTRY[topic].knomosis;
}

/** Structured outcome of {@link parseEvent}. */
export type ParseEventResult =
  | { ok: true; event: LicioEvent }
  | { ok: false; reason: 'unknown_topic' | 'invalid_envelope' | 'invalid_payload'; detail: string };

/**
 * Parse an arbitrary value into a registered event: envelope check → registry
 * lookup → full topic-schema validation. Equivalent to the discriminated union
 * but yields a structured reason for the boundary's 400 responses.
 */
export function parseEvent(value: unknown): ParseEventResult {
  const envelope = eventEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    return {
      ok: false,
      reason: 'invalid_envelope',
      detail: envelope.error.issues[0]?.message ?? 'invalid envelope',
    };
  }
  const topic = envelope.data.event_type;
  if (!isRegisteredTopic(topic)) {
    return { ok: false, reason: 'unknown_topic', detail: `unregistered event_type "${topic}"` };
  }
  const parsed = TOPIC_REGISTRY[topic].schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: parsed.error.issues[0]?.message ?? 'invalid payload',
    };
  }
  return { ok: true, event: parsed.data };
}
