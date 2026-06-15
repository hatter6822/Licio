// SPDX-License-Identifier: AGPL-3.0-or-later
//
// No-drift gate: the WS-J code constants in @licio/shared MUST equal the
// ratified policy documents (MODERATION_TAXONOMY.md severity/appealability/SLA +
// emergency set, STEWARD_ROLES.md role grants).  Hosted here (the api node test
// project) because it reads the docs from disk and resolves @licio/shared; if
// the doctrine and the code diverge, CI fails — the no-drift discipline the
// policy validator already applies to the documents themselves.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EMERGENCY_REASON_CODES,
  IMMINENT_RISK_REASON_CODES,
  MODERATION_REASON_CODES,
  type ModerationReasonCode,
  reasonCodeAppealable,
  reasonCodeSeverity,
  reasonCodeSlaHours,
  SEVERITY_SLA_HOURS,
  STEWARD_ROLE_DOCTRINE,
  STEWARD_ROLE_IDS,
  type StewardRoleId,
} from '@licio/shared';
import { describe, expect, it } from 'vitest';

const POLICY_DIR = resolve(import.meta.dirname, '../../../../docs/policy');

function loadJsonBlock(file: string): Record<string, unknown> {
  const raw = readFileSync(resolve(POLICY_DIR, file), 'utf-8');
  const match = /```json\s*\n([\s\S]*?)```/.exec(raw);
  if (!match?.[1]) throw new Error(`no JSON block in ${file}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

const hoursOf = (slaTarget: string): number => Number(slaTarget.replace(/h$/, ''));

describe('WS-J code constants vs ratified MODERATION_TAXONOMY.md', () => {
  const taxonomy = loadJsonBlock('MODERATION_TAXONOMY.md');
  const reasonCodes = taxonomy['reason_codes'] as Array<{
    reason_code: string;
    severity_default: string;
    appealable: boolean;
    sla_target: string;
  }>;
  const severities = taxonomy['severities'] as Array<{ severity: string; sla_target: string }>;

  it('SEVERITY_SLA_HOURS equals the document severity table', () => {
    for (const { severity, sla_target } of severities) {
      expect(SEVERITY_SLA_HOURS[severity as keyof typeof SEVERITY_SLA_HOURS]).toBe(
        hoursOf(sla_target),
      );
    }
  });

  it('reason-code severity / appealability / SLA match the document, code-for-code', () => {
    expect(reasonCodes.length).toBe(MODERATION_REASON_CODES.length);
    for (const entry of reasonCodes) {
      const code = entry.reason_code as ModerationReasonCode;
      expect(MODERATION_REASON_CODES).toContain(code);
      expect(reasonCodeSeverity(code)).toBe(entry.severity_default);
      expect(reasonCodeAppealable(code)).toBe(entry.appealable);
      expect(reasonCodeSlaHours(code)).toBe(hoursOf(entry.sla_target));
    }
  });

  it('the emergency set equals {critical} ∪ {imminent-risk} (WS-J.1.1b)', () => {
    const expected = new Set<string>([
      ...reasonCodes.filter((r) => r.severity_default === 'critical').map((r) => r.reason_code),
      ...IMMINENT_RISK_REASON_CODES,
    ]);
    expect(new Set([...EMERGENCY_REASON_CODES])).toEqual(expected);
  });
});

describe('WS-J role grants vs ratified STEWARD_ROLES.md', () => {
  const roles = loadJsonBlock('STEWARD_ROLES.md')['roles'] as Array<{
    role_id: string;
    actions: string[];
    queues: string[];
  }>;

  it('defines exactly the five ratified roles', () => {
    expect([...STEWARD_ROLE_IDS].sort()).toEqual(roles.map((r) => r.role_id).sort());
  });

  it('STEWARD_ROLE_DOCTRINE equals the document grants exactly', () => {
    for (const docRole of roles) {
      const policy = STEWARD_ROLE_DOCTRINE[docRole.role_id as StewardRoleId];
      expect([...policy.actions].sort()).toEqual([...docRole.actions].sort());
      expect([...policy.queues].sort()).toEqual([...docRole.queues].sort());
    }
  });
});
