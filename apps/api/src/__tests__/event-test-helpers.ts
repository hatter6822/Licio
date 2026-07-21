// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Identity + event-pipeline in-memory test fixtures: fresh service bundles
// installed as the module singletons, seeded users with session cookies, and
// canonical event builders.

import { randomUUID } from 'node:crypto';
import {
  type AttentionAggregate,
  type AttentionAggregateEvent,
  attentionAggregateEventSchema,
  attentionAggregateSchema,
  type ContentSavedAggregateEvent,
  contentSavedAggregateEventSchema,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  type PrivacySettings,
  type SourceOpenedAggregateEvent,
  sourceOpenedAggregateEventSchema,
} from '@licio/shared';
import { ensureComplianceServicesForTests } from '../compliance/services.js';
import {
  createInMemoryEventPipelineServices,
  type EventPipelineServices,
  type InMemoryEventServicesOptions,
  setEventPipelineServices,
} from '../events/services.js';
import {
  createInMemoryIdentityServices,
  type IdentityConfig,
  type IdentityServices,
  setIdentityServices,
} from '../identity/services.js';
import { buildSessionCookie, createSession } from '../identity/sessions.js';

export const TEST_IDENTITY_CONFIG: IdentityConfig = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
  signupPow: { maxNumber: 16 },
};

export interface EventServicesFixture {
  identity: IdentityServices;
  events: EventPipelineServices;
}

/** Fresh in-memory bundles, installed as the module singletons. */
export function freshEventServices(
  options: InMemoryEventServicesOptions = {},
): EventServicesFixture {
  const identity = createInMemoryIdentityServices(TEST_IDENTITY_CONFIG);
  const events = createInMemoryEventPipelineServices(options);
  setIdentityServices(identity);
  setEventPipelineServices(events);
  return { identity, events };
}

export interface SeededUser {
  userId: string;
  cookie: string;
}

/**
 * Seeded accounts are created 7 days OLD so the WS-F account-age precheck
 * passes regardless of which clock a suite runs on.  Suites pin `now` to a
 * wall-date (e.g. noon today) while the identity store stamps `created_at`
 * with the REAL clock — without the backdate, a user created after the
 * pinned instant has NEGATIVE age and every submission 403s the moment the
 * wall clock passes the pin (a time bomb, not a flake).
 *
 * The 7-day backdate is only a grace window, NOT a fix: it masks the gap
 * until the REAL clock reaches `pin + 7 days`, after which a real-clock-seeded
 * account is again newer than the pinned instant and every story submission
 * 403s `account_too_new` forever.  So ANY suite that both pins `now` to a fixed
 * wall-clock instant AND submits through the account-age gate (`POST
 * /v1/stories`) MUST pass that same `nowMs` here, so the account backdates from
 * the pinned clock instead of the real one.  (Suites that pin a clock but never
 * cross the age gate — most forum/ranking/invariants suites — are unaffected.)
 */
const SEEDED_ACCOUNT_AGE_MS = 7 * 24 * 3_600_000;

/** Seed an active, verified user and return a live session cookie. */
export async function seedUserWithSession(
  identity: IdentityServices,
  opts: {
    privacySettings?: PrivacySettings;
    handle?: string;
    /** Seed a TOTP-cleared steward (the WS-E admin-surface bar, WS-D.1.5b). */
    steward?: boolean;
    /** Seed a TOTP-cleared `admin` (the AI team — `ai.model.manage`, WS-K.1.1b). */
    admin?: boolean;
    /** Seed a platform `expert` (WS-D RBAC; may post in expert-gated rooms). */
    expert?: boolean;
    /** The suite's pinned clock (account creation backdates from it). */
    nowMs?: number;
    /** Override the seeded account's age (0 ⇒ created exactly "now"). */
    accountAgeMs?: number;
    /** Seed a reviewer-verified KYC standing (bot-prevention layer 3).
     *  Defaults TRUE — the standard test actor is fully capable, mirroring the
     *  seeded webauthn credential + adult band; pass false to exercise the
     *  governance-eligibility gate's denial path. */
    kyc?: boolean;
  } = {},
): Promise<SeededUser> {
  const user = await identity.store.createUser(
    {
      handle: opts.handle ?? `reader${randomUUID().slice(0, 8)}`,
      displayName: 'Reader',
      email: null,
      accountState: 'active',
      locale: null,
      ageBand: 'adult',
      privacySettings: opts.privacySettings ?? defaultPrivacySettings(),
      personalizationSettings: defaultPersonalizationSettings(),
      roles: opts.admin
        ? ['user', 'admin']
        : opts.steward
          ? ['user', 'steward']
          : opts.expert
            ? ['user', 'expert']
            : ['user'],
    },
    (opts.nowMs ?? Date.now()) - (opts.accountAgeMs ?? SEEDED_ACCOUNT_AGE_MS),
  );
  if (opts.steward || opts.admin) {
    await identity.store.setAuth(user.userId, { mfaEnabled: true });
  }
  if (opts.kyc !== false) {
    // Bot-prevention layer 3: mark the actor KYC-verified in the SAME store
    // the governance-eligibility guard reads (the compliance container; the
    // test bootstrap creates one when the suite has not wired WS-N).
    const nowIso = new Date().toISOString();
    await ensureComplianceServicesForTests().kyc.upsert({
      userId: user.userId,
      status: 'verified',
      evidenceRef: 'test-fixture',
      verifiedAt: nowIso,
      verifiedBy: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }
  await identity.store.addWebauthn({
    credentialId: `cred-${user.userId}`,
    userId: user.userId,
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    deviceType: 'platform',
    deviceName: null,
    transports: [],
    backedUp: false,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  });
  const created = await createSession(identity.sessions, {
    userId: user.userId,
    authMethod: 'webauthn',
    credentialRef: `cred-${user.userId}`,
    deviceLabel: 'test',
    rememberMe: false,
    mfaVerified: opts.steward === true || opts.admin === true,
  });
  const cookie = buildSessionCookie(created.token, created.maxAgeSec).split(';')[0] as string;
  return { userId: user.userId, cookie };
}

/** A canonical attention.aggregate event for `userId` at `timestamp`. */
export function attentionEvent(
  userId: string,
  overrides: Partial<AttentionAggregateEvent> & { storyId?: string } = {},
): AttentionAggregateEvent {
  const { storyId, ...rest } = overrides;
  if (Array.isArray(rest.items)) {
    rest.items = rest.items.map((item) => {
      const legacy = item as Record<string, unknown>;
      if ('branch_depth_bucket' in legacy && !('reply_depth_bucket' in legacy)) {
        const { branch_depth_bucket, ...withoutLegacy } = legacy;
        return { ...withoutLegacy, reply_depth_bucket: branch_depth_bucket };
      }
      return item;
    }) as typeof rest.items;
  }
  return attentionAggregateEventSchema.parse({
    event_id: randomUUID(),
    event_type: 'attention.aggregate',
    timestamp: new Date().toISOString(),
    schema_version: '1',
    nonce: randomUUID(),
    user_id: userId,
    privacy_level: 'standard',
    session_bucket: '2026-06-10T10:00:00.000Z',
    items: [
      {
        story_id: storyId ?? randomUUID(),
        active_dwell_bucket: 'medium',
        source_opened: true,
        context_opened: false,
        reply_depth_bucket: 'shallow',
        return_visit_count_bucket: 'none',
      },
    ],
    privacy_classification: 'aggregated',
    retention_tier: 'attention_aggregated',
    ...rest,
  });
}

/** A canonical source.opened.aggregate event. */
export function sourceOpenEvent(
  userId: string,
  overrides: Partial<SourceOpenedAggregateEvent> = {},
): SourceOpenedAggregateEvent {
  return sourceOpenedAggregateEventSchema.parse({
    event_id: randomUUID(),
    event_type: 'source.opened.aggregate',
    timestamp: new Date().toISOString(),
    schema_version: '1',
    nonce: randomUUID(),
    user_id: userId,
    privacy_level: 'standard',
    story_id: randomUUID(),
    source_id: randomUUID(),
    dwell_bucket: 'moderate',
    bounce: false,
    privacy_classification: 'aggregated',
    retention_tier: 'attention_aggregated',
    ...overrides,
  });
}

/** A canonical content.saved (SIG-ATT-SAVE, §5.3) event. */
export function contentSavedEvent(
  userId: string,
  overrides: Partial<ContentSavedAggregateEvent> = {},
): ContentSavedAggregateEvent {
  return contentSavedAggregateEventSchema.parse({
    event_id: randomUUID(),
    event_type: 'content.saved',
    timestamp: new Date().toISOString(),
    schema_version: '1',
    nonce: randomUUID(),
    user_id: userId,
    privacy_level: 'standard',
    story_id: randomUUID(),
    privacy_classification: 'aggregated',
    retention_tier: 'attention_aggregated',
    ...overrides,
  });
}

/** A legacy §22.1 aggregate (the WS-C batch wire shape). */
export function legacyAggregate(
  ownerOrBucket: string,
  overrides: Partial<AttentionAggregate> = {},
): AttentionAggregate {
  return attentionAggregateSchema.parse({
    aggregate_id: randomUUID(),
    user_id_or_privacy_bucket: ownerOrBucket,
    story_id: randomUUID(),
    session_bucket: '2026-06-10T10:00:00.000Z',
    active_dwell_bucket: 'short',
    source_opened: true,
    context_opened: false,
    reply_depth_bucket: 'shallow',
    return_visit_count_bucket: 'none',
    privacy_level: 'standard',
    created_at: new Date().toISOString(),
    ...overrides,
  });
}
