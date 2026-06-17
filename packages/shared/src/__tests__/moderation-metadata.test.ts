// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure behavioural tests for the WS-J reason-code metadata + steward-role
// helpers (no filesystem — the doc-drift cross-check lives in the node-typed
// scripts/policy project).  These pin the SEMANTICS the report router, SLA
// tracker, and appeal gate rely on.
import { describe, expect, it } from 'vitest';
import {
  EMERGENCY_REASON_CODES,
  IMMINENT_RISK_REASON_CODES,
  isEmergencyReasonCode,
  MODERATION_REASON_CODES,
  reasonCodeAppealable,
  reasonCodeSeverity,
  reasonCodeSlaHours,
  SEVERITY_SLA_HOURS,
  toEventSeverity,
} from '../constants/moderation.js';
import { reportQueueFilterSchema } from '../schemas/moderation-console-api.js';
import {
  appealEligibility,
  isSignificantAction,
  SENIOR_ONLY_CAPABILITIES,
  STEWARD_ROLE_CAPABILITIES,
  stewardRolesCan,
  stewardRolesCanAccessQueue,
  stewardRolesQueues,
} from '../schemas/steward-roles.js';

describe('reportQueueFilterSchema query coercion (WS-J.2.1b)', () => {
  it('accepts a lone scalar filter value (single-value query param)', () => {
    const parsed = reportQueueFilterSchema.parse({
      severity: 'moderate',
      status: 'new',
      category: 'MOD_HARASS',
    });
    expect(parsed.severity).toEqual(['moderate']);
    expect(parsed.status).toEqual(['new']);
    expect(parsed.category).toEqual(['MOD_HARASS']);
  });

  it('accepts repeated (array) filter values and leaves them as arrays', () => {
    const parsed = reportQueueFilterSchema.parse({ severity: ['moderate', 'severe'] });
    expect(parsed.severity).toEqual(['moderate', 'severe']);
  });

  it('omits absent filters and still rejects an invalid value', () => {
    expect(reportQueueFilterSchema.parse({}).severity).toBeUndefined();
    expect(() => reportQueueFilterSchema.parse({ severity: 'not-a-severity' })).toThrow();
  });
});

describe('reason-code severity / SLA / appealability', () => {
  it('every ratified code has metadata and a derived SLA', () => {
    for (const code of MODERATION_REASON_CODES) {
      const severity = reasonCodeSeverity(code);
      expect(SEVERITY_SLA_HOURS[severity]).toBe(reasonCodeSlaHours(code));
    }
  });

  it('maps severity to the WS-E event scale', () => {
    expect(toEventSeverity('minor')).toBe('low');
    expect(toEventSeverity('moderate')).toBe('medium');
    expect(toEventSeverity('severe')).toBe('high');
    expect(toEventSeverity('critical')).toBe('critical');
  });

  it('CSAM and imminent-threat codes are non-appealable; harassment is', () => {
    expect(reasonCodeAppealable('MOD_CSE_001')).toBe(false);
    expect(reasonCodeAppealable('MOD_THREAT_001')).toBe(false);
    expect(reasonCodeAppealable('MOD_HATE_003')).toBe(false);
    expect(reasonCodeAppealable('MOD_HARASS_001')).toBe(true);
  });

  it('the emergency set is the critical codes plus the imminent-risk additions', () => {
    // Every critical code is emergency.
    for (const code of MODERATION_REASON_CODES) {
      if (reasonCodeSeverity(code) === 'critical') expect(isEmergencyReasonCode(code)).toBe(true);
    }
    // The imminent-risk additions are emergency but not critical.
    for (const code of IMMINENT_RISK_REASON_CODES) {
      expect(isEmergencyReasonCode(code)).toBe(true);
      expect(reasonCodeSeverity(code)).not.toBe('critical');
    }
    // A plain spam code is not emergency.
    expect(isEmergencyReasonCode('MOD_SPAM_001')).toBe(false);
    expect(EMERGENCY_REASON_CODES.size).toBeGreaterThan(0);
  });
});

describe('steward-role capabilities', () => {
  it('separates remove / overturn / integrity capabilities by role', () => {
    expect(stewardRolesCan(['ROLE_SAFETY'], 'remove')).toBe(true);
    expect(stewardRolesCan(['ROLE_COMMUNITY'], 'remove')).toBe(false);
    expect(stewardRolesCan(['ROLE_APPEALS'], 'overturn')).toBe(true);
    expect(stewardRolesCan(['ROLE_SAFETY'], 'overturn')).toBe(false);
    expect(stewardRolesCan(['ROLE_INTEGRITY'], 'mfci-coordination-detail')).toBe(true);
  });

  it('grants escalate/clear to report-queue roles only', () => {
    expect(STEWARD_ROLE_CAPABILITIES.ROLE_SAFETY.actions).toContain('escalate');
    expect(STEWARD_ROLE_CAPABILITIES.ROLE_COMMUNITY.actions).toContain('clear');
    expect(STEWARD_ROLE_CAPABILITIES.ROLE_EVIDENCE.actions).not.toContain('escalate');
  });

  it('unions queues across multiple roles', () => {
    expect(stewardRolesQueues(['ROLE_SAFETY', 'ROLE_APPEALS']).sort()).toEqual(
      ['appeal-queue', 'report-queue'].sort(),
    );
    expect(stewardRolesCanAccessQueue(['ROLE_INTEGRITY'], 'integrity-queue')).toBe(true);
  });

  it('marks permanent ban as a senior-only capability', () => {
    expect(SENIOR_ONLY_CAPABILITIES.has('ban')).toBe(true);
    expect(SENIOR_ONLY_CAPABILITIES.has('warn')).toBe(false);
  });
});

describe('appeal eligibility', () => {
  it('immediate for warn/hide/restrict/suspend', () => {
    for (const a of ['warn', 'hide', 'restrict', 'suspend'] as const) {
      expect(appealEligibility(a).appealable).toBe(true);
    }
  });

  it('remove follows the reason-code lawful-basis exception', () => {
    expect(appealEligibility('remove', { reasonCode: 'MOD_HARASS_001' }).appealable).toBe(true);
    expect(appealEligibility('remove', { reasonCode: 'MOD_CSE_001' }).appealable).toBe(false);
    expect(appealEligibility('remove').appealable).toBe(true); // unknown reason → appealable
  });

  it('ban appeal is senior + cooldown-gated; emergency is deferred', () => {
    const ban = appealEligibility('ban', { banCooldownHours: 12 });
    expect(ban.senior).toBe(true);
    expect(ban.availableAfterHours).toBe(12);
    expect(appealEligibility('emergency_restriction').appealable).toBe(false);
    expect(
      appealEligibility('emergency_restriction', { emergencyReviewComplete: true }).appealable,
    ).toBe(true);
  });

  it('shadow requires user notice before it is appealable', () => {
    expect(appealEligibility('shadow', { shadowUserNotified: false }).appealable).toBe(false);
    expect(appealEligibility('shadow', { shadowUserNotified: true }).appealable).toBe(true);
  });

  it('classifies significant actions for notice generation', () => {
    expect(isSignificantAction('remove')).toBe(true);
    expect(isSignificantAction('clear')).toBe(false);
    expect(isSignificantAction('escalate')).toBe(false);
  });
});
