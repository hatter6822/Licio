// SPDX-License-Identifier: AGPL-3.0-or-later
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POLICY_FILES, loadDocs, validatePolicyDocs } from '../validate.ts';

const POLICY_DIR = resolve(import.meta.dirname, '../../../docs/policy');
const SPEC_PATH = resolve(POLICY_DIR, '..', 'SPEC.md');

/** Copy the real policy docs into a throwaway dir and apply a single mutation. */
function withMutatedDocs(file: string, mutate: (raw: string) => string): string[] {
  const tmp = mkdtempSync(join(tmpdir(), 'licio-policy-'));
  try {
    cpSync(POLICY_DIR, tmp, { recursive: true });
    const target = join(tmp, file);
    writeFileSync(target, mutate(readFileSync(target, 'utf-8')), 'utf-8');
    // Cross-validate against the real SPEC so mutations are tested under full rules.
    return validatePolicyDocs(tmp, SPEC_PATH);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('policy doctrine documents (WS-A)', () => {
  it('all eight documents are internally and cross-consistent', () => {
    expect(validatePolicyDocs(POLICY_DIR)).toEqual([]);
  });

  it('loads a canonical JSON enumeration for every document', () => {
    const docs = loadDocs(POLICY_DIR);
    expect(docs.size).toBe(Object.keys(POLICY_FILES).length);
    for (const doc of docs.values()) {
      expect(doc.jsonError, `${doc.name} should parse`).toBeNull();
      expect(doc.json, `${doc.name} should have a JSON block`).not.toBeNull();
    }
  });

  it('SIGNAL_MATRIX enumerates the expected signal counts', () => {
    const json = loadDocs(POLICY_DIR).get('SIGNAL_MATRIX')?.json;
    const signals = (json?.signals as { kind: string }[]) ?? [];
    const count = (kind: string) => signals.filter((s) => s.kind === kind).length;
    expect(count('attention')).toBe(7);
    expect(count('participation')).toBe(8);
    expect(count('prohibited')).toBe(14);
    expect(count('anti')).toBe(7);
  });
});

describe('validator catches regressions', () => {
  it('flags missing documents', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'licio-empty-'));
    try {
      const errors = validatePolicyDocs(tmp);
      expect(errors.some((e) => e.includes('file not found'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('flags non-disjoint signal IDs', () => {
    const errors = withMutatedDocs(POLICY_FILES.SIGNAL_MATRIX, (raw) =>
      raw.replace('"id": "SIG-ATT-SAVE"', '"id": "SIG-ATT-DWELL"'),
    );
    expect(errors.some((e) => e.includes('not disjoint/unique'))).toBe(true);
  });

  it('flags a severity/SLA inconsistency', () => {
    const errors = withMutatedDocs(POLICY_FILES.MODERATION_TAXONOMY, (raw) =>
      raw.replace(
        '"reason_code": "MOD_SPAM_001", "severity_default": "minor", "appealable": true, "sla_target": "72h"',
        '"reason_code": "MOD_SPAM_001", "severity_default": "minor", "appealable": true, "sla_target": "24h"',
      ),
    );
    expect(errors.some((e) => e.includes('MOD_SPAM_001') && e.includes('SLA'))).toBe(true);
  });

  it('flags a broken count', () => {
    const errors = withMutatedDocs(POLICY_FILES.TRANSPARENCY_DICTIONARY, (raw) =>
      raw.replace('{ "anti_metric_id": "AM-VOTEVOL" },\n', ''),
    );
    expect(errors.some((e) => e.includes('anti-metrics'))).toBe(true);
  });

  it('flags policy<->suite mapping drift between SIGNAL_MATRIX and SIGNAL_TEST_MAP', () => {
    const errors = withMutatedDocs(POLICY_FILES.SIGNAL_TEST_MAP, (raw) =>
      raw.replace(
        '"rnt_id": "RNT-013", "signal_id": "SIG-PROH-NFT", "suite_test": "WS-I.3.1b"',
        '"rnt_id": "RNT-013", "signal_id": "SIG-PROH-NFT", "suite_test": "WS-I.3.1c"',
      ),
    );
    expect(errors.some((e) => e.includes('mapping drift'))).toBe(true);
  });

  it('flags a crypto tier that is not fail-closed', () => {
    const errors = withMutatedDocs(POLICY_FILES.CRYPTO_FEATURE_MATRIX, (raw) =>
      raw.replace(
        '{ "tier_id": "CRYPTO_T3", "name": "Capped production", "default_state": "disabled" }',
        '{ "tier_id": "CRYPTO_T3", "name": "Capped production", "default_state": "enabled" }',
      ),
    );
    expect(errors.some((e) => e.includes('fail-closed'))).toBe(true);
  });

  it('flags an undefined steward role referenced by the moderation taxonomy', () => {
    const errors = withMutatedDocs(POLICY_FILES.STEWARD_ROLES, (raw) =>
      raw.replace(/"role_id": "ROLE_INTEGRITY"/g, '"role_id": "ROLE_INTEGRITYX"'),
    );
    expect(errors.some((e) => e.includes('ROLE_INTEGRITY'))).toBe(true);
  });

  it('flags a transparency metric missing its aggregation method', () => {
    const errors = withMutatedDocs(POLICY_FILES.TRANSPARENCY_DICTIONARY, (raw) =>
      raw.replace('"aggregation": "Ratio (source opens / views)", ', ''),
    );
    expect(errors.some((e) => e.includes('missing aggregation method'))).toBe(true);
  });

  it('flags a moderation layer dropped from the enumeration', () => {
    const errors = withMutatedDocs(POLICY_FILES.MODERATION_TAXONOMY, (raw) =>
      raw.replace(
        '    { "layer": "Integrity review", "operated_by": ["ROLE_INTEGRITY"], "escalation_trigger": "MFCI flag; multi-account pattern; financial-fraud signal" },\n',
        '',
      ),
    );
    expect(errors.some((e) => e.includes('6 moderation layers'))).toBe(true);
  });

  it('flags an exemplar jurisdiction row that enables a crypto cell without legal approval', () => {
    const errors = withMutatedDocs(POLICY_FILES.JURISDICTION_MATRIX, (raw) =>
      raw.replace(
        '"region_code": "US-CA",\n      "legal_review_status": "pending",\n      "cells": {\n        "core_social": "enabled",\n        "wallet_connection": "pending-legal"',
        '"region_code": "US-CA",\n      "legal_review_status": "pending",\n      "cells": {\n        "core_social": "enabled",\n        "wallet_connection": "enabled"',
      ),
    );
    expect(errors.some((e) => e.includes('fail-closed violation'))).toBe(true);
  });

  it('flags doc/SPEC drift when a signal name no longer matches SPEC §5.3', () => {
    const errors = withMutatedDocs(POLICY_FILES.SIGNAL_MATRIX, (raw) =>
      raw.replace('"name": "Active dwell"', '"name": "Passive dwell"'),
    );
    expect(errors.some((e) => e.includes('SPEC §5.3 attention'))).toBe(true);
  });

  it('flags a privacy doc missing a SPEC §19.2 handling row', () => {
    const errors = withMutatedDocs(POLICY_FILES.PRIVACY_REGULATION_MAP, (raw) =>
      raw.replace(
        '    { "data": "Context opens", "default_handling": "Upload aggregate; used for ranking and UI improvement" },\n',
        '',
      ),
    );
    expect(
      errors.some((e) => e.includes('§19.2') && (e.includes('7') || e.includes('disagree'))),
    ).toBe(true);
  });
});
