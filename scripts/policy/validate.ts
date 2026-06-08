// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Validator for the WS-A doctrine & policy documents in docs/policy/.
//
// WS-A is a document-only workstream, but its deliverables carry stable identifiers,
// closed vocabularies, and bijective policy<->engineering mappings that downstream
// workstreams (WS-E, WS-H, WS-I, WS-J, WS-N, WS-P) consume programmatically. This module
// enforces the "Testing" assertions defined in docs/planning/02-doctrine-and-policy.md:
// coverage counts, ID disjointness, naming conventions, severity<->SLA consistency,
// the bijective RNT<->signal<->suite mapping, closed cell vocabularies, cross-document
// reference integrity, and prose<->machine-readable consistency.
//
// It is consumed both by scripts/check-policy.ts (CLI gate) and by the Vitest suite in
// scripts/policy/__tests__/validate.test.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// --- Shared shapes ---------------------------------------------------------------------

export interface PolicyDoc {
  name: string;
  fileName: string;
  raw: string;
  prose: string;
  json: Record<string, unknown> | null;
  jsonError: string | null;
}

const FILES: Record<string, string> = {
  SIGNAL_MATRIX: 'SIGNAL_MATRIX.md',
  MODERATION_TAXONOMY: 'MODERATION_TAXONOMY.md',
  TRANSPARENCY_DICTIONARY: 'TRANSPARENCY_DICTIONARY.md',
  SIGNAL_TEST_MAP: 'SIGNAL_TEST_MAP.md',
  STEWARD_ROLES: 'STEWARD_ROLES.md',
  CRYPTO_FEATURE_MATRIX: 'CRYPTO_FEATURE_MATRIX.md',
  JURISDICTION_MATRIX: 'JURISDICTION_MATRIX.md',
  PRIVACY_REGULATION_MAP: 'PRIVACY_REGULATION_MAP.md',
};

const SLA_BY_SEVERITY: Record<string, string> = {
  minor: '72h',
  moderate: '24h',
  severe: '4h',
  critical: '1h',
};
const SEVERITY_ORDER = ['minor', 'moderate', 'severe', 'critical'];

// --- Small typed accessors (no `any`) --------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getArray(obj: Record<string, unknown>, key: string): unknown[] {
  const value = obj[key];
  return Array.isArray(value) ? value : [];
}

function getString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value : '';
}

function getBool(obj: Record<string, unknown>, key: string): boolean | null {
  const value = obj[key];
  return typeof value === 'boolean' ? value : null;
}

function getStringArray(obj: Record<string, unknown>, key: string): string[] {
  return getArray(obj, key).filter((v): v is string => typeof v === 'string');
}

function records(values: unknown[]): Record<string, unknown>[] {
  return values.filter(isRecord);
}

function unique<T>(values: T[]): boolean {
  return new Set(values).size === values.length;
}

function duplicates<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const dupes = new Set<T>();
  for (const v of values) {
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  return [...dupes];
}

// --- Document loading ------------------------------------------------------------------

function extractJsonBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  for (const match of markdown.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
    blocks.push(match[1] ?? '');
  }
  return blocks;
}

function stripCodeBlocks(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '');
}

export function loadDocs(dir: string): Map<string, PolicyDoc> {
  const docs = new Map<string, PolicyDoc>();
  for (const [name, fileName] of Object.entries(FILES)) {
    let raw = '';
    let json: Record<string, unknown> | null = null;
    let jsonError: string | null = null;
    try {
      raw = readFileSync(join(dir, fileName), 'utf-8');
    } catch {
      jsonError = 'file not found';
      docs.set(name, { name, fileName, raw: '', prose: '', json: null, jsonError });
      continue;
    }
    const blocks = extractJsonBlocks(raw);
    if (blocks.length === 0) {
      jsonError = 'no canonical JSON enumeration block found';
    } else if (blocks.length > 1) {
      jsonError = `expected exactly one JSON enumeration block, found ${blocks.length}`;
    } else {
      try {
        const parsed: unknown = JSON.parse(blocks[0] ?? '');
        if (isRecord(parsed)) {
          json = parsed;
        } else {
          jsonError = 'canonical enumeration is not a JSON object';
        }
      } catch (err) {
        jsonError = `invalid JSON: ${(err as Error).message}`;
      }
    }
    docs.set(name, { name, fileName, raw, prose: stripCodeBlocks(raw), json, jsonError });
  }
  return docs;
}

// --- Generic consistency helpers -------------------------------------------------------

type Push = (msg: string) => void;

function requireHeaderFields(doc: PolicyDoc, push: Push): void {
  for (const field of ['Version', 'Owner', 'Effective date', 'Changelog']) {
    if (!doc.raw.includes(field)) {
      push(`${doc.name}: missing required document field "${field}"`);
    }
  }
}

// Forward check: every canonical id must be documented in the human-readable prose.
function checkProsePresence(doc: PolicyDoc, ids: string[], push: Push): void {
  for (const id of ids) {
    if (!doc.prose.includes(id)) {
      push(`${doc.name}: id "${id}" is in the machine-readable block but missing from prose`);
    }
  }
}

// Reverse check: every prose token matching `pattern` must be a known canonical id, or a
// namespace prefix of one (allows e.g. "MOD_CRYPTO_*" or "MOD_HARASS_*" namespace mentions).
function checkProseTokens(doc: PolicyDoc, pattern: RegExp, known: Set<string>, push: Push): void {
  for (const match of doc.prose.matchAll(pattern)) {
    const token = match[0];
    if (known.has(token)) continue;
    let isPrefix = false;
    for (const id of known) {
      if (id.startsWith(`${token}_`)) {
        isPrefix = true;
        break;
      }
    }
    if (!isPrefix) {
      push(`${doc.name}: prose references unknown identifier "${token}"`);
    }
  }
}

// --- Per-document validators -----------------------------------------------------------

function validateSignalMatrix(doc: PolicyDoc, push: Push): void {
  if (!doc.json) return;
  const signals = records(getArray(doc.json, 'signals'));
  const byKind: Record<string, Record<string, unknown>[]> = {
    attention: [],
    participation: [],
    prohibited: [],
    anti: [],
  };
  const prefix: Record<string, string> = {
    attention: 'SIG-ATT-',
    participation: 'SIG-PART-',
    prohibited: 'SIG-PROH-',
    anti: 'SIG-ANTI-',
  };
  const allIds: string[] = [];
  for (const s of signals) {
    const id = getString(s, 'id');
    const kind = getString(s, 'kind');
    allIds.push(id);
    if (byKind[kind]) {
      byKind[kind].push(s);
      if (!id.startsWith(prefix[kind] ?? '~')) {
        push(`SIGNAL_MATRIX: signal "${id}" does not match the "${prefix[kind]}" convention`);
      }
    } else {
      push(`SIGNAL_MATRIX: signal "${id}" has unknown kind "${kind}"`);
    }
  }

  const expect: Record<string, number> = {
    attention: 7,
    participation: 8,
    prohibited: 14,
    anti: 7,
  };
  for (const [kind, count] of Object.entries(expect)) {
    if ((byKind[kind]?.length ?? 0) !== count) {
      push(`SIGNAL_MATRIX: expected ${count} ${kind} signals, found ${byKind[kind]?.length ?? 0}`);
    }
  }

  if (!unique(allIds)) {
    push(`SIGNAL_MATRIX: signal IDs are not disjoint/unique: ${duplicates(allIds).join(', ')}`);
  }

  const rntIds: string[] = [];
  for (const s of byKind.prohibited ?? []) {
    const id = getString(s, 'id');
    const rnt = getString(s, 'rnt');
    const suite = getString(s, 'suite');
    if (!/^RNT-\d{3}$/.test(rnt)) {
      push(`SIGNAL_MATRIX: prohibited signal "${id}" has malformed RNT id "${rnt}"`);
    }
    if (!/^WS-I\.3\.1[a-z]$/.test(suite)) {
      push(`SIGNAL_MATRIX: prohibited signal "${id}" has malformed suite test "${suite}"`);
    }
    rntIds.push(rnt);
  }
  if (!unique(rntIds)) {
    push(`SIGNAL_MATRIX: RNT ids are not unique: ${duplicates(rntIds).join(', ')}`);
  }

  for (const s of byKind.anti ?? []) {
    for (const cond of getStringArray(s, 'conditioning')) {
      if (cond !== 'MFCI-1' && cond !== 'MFCI-2') {
        push(
          `SIGNAL_MATRIX: anti-signal "${getString(s, 'id')}" has unknown conditioning "${cond}"`,
        );
      }
    }
  }

  checkProsePresence(doc, allIds, push);
  checkProseTokens(doc, /SIG-(?:ATT|PART|PROH|ANTI)-[A-Z]+/g, new Set(allIds), push);
}

function validateModerationTaxonomy(doc: PolicyDoc, push: Push): void {
  if (!doc.json) return;

  // Severities <-> SLA
  const severities = records(getArray(doc.json, 'severities'));
  const seenSeverities = new Set<string>();
  for (const s of severities) {
    const sev = getString(s, 'severity');
    const sla = getString(s, 'sla_target');
    seenSeverities.add(sev);
    if (SLA_BY_SEVERITY[sev] === undefined) {
      push(`MODERATION_TAXONOMY: unknown severity "${sev}"`);
    } else if (SLA_BY_SEVERITY[sev] !== sla) {
      push(
        `MODERATION_TAXONOMY: severity "${sev}" SLA "${sla}" != canonical "${SLA_BY_SEVERITY[sev]}"`,
      );
    }
  }
  for (const sev of SEVERITY_ORDER) {
    if (!seenSeverities.has(sev)) push(`MODERATION_TAXONOMY: missing severity level "${sev}"`);
  }

  // Categories
  const categories = records(getArray(doc.json, 'categories'));
  if (categories.length !== 12) {
    push(`MODERATION_TAXONOMY: expected 12 policy categories, found ${categories.length}`);
  }
  const categoryIds: string[] = [];
  for (const c of categories) {
    const id = getString(c, 'category_id');
    categoryIds.push(id);
    if (!/^MOD_[A-Z]+$/.test(id)) {
      push(`MODERATION_TAXONOMY: malformed category id "${id}"`);
    }
    if (getString(c, 'namespace') !== `${id}_*`) {
      push(`MODERATION_TAXONOMY: category "${id}" namespace must be "${id}_*"`);
    }
    const range = getStringArray(c, 'severity_range');
    for (const sev of range) {
      if (!SEVERITY_ORDER.includes(sev))
        push(`MODERATION_TAXONOMY: category "${id}" bad severity "${sev}"`);
    }
    if (range.length === 2) {
      const lo = SEVERITY_ORDER.indexOf(range[0] ?? '');
      const hi = SEVERITY_ORDER.indexOf(range[1] ?? '');
      if (lo > hi) push(`MODERATION_TAXONOMY: category "${id}" severity_range is inverted`);
    }
  }
  if (!unique(categoryIds)) {
    push(`MODERATION_TAXONOMY: category ids not unique: ${duplicates(categoryIds).join(', ')}`);
  }

  // Crypto modes
  const cryptoModes = records(getArray(doc.json, 'crypto_modes'));
  if (cryptoModes.length !== 15) {
    push(`MODERATION_TAXONOMY: expected 15 crypto modes, found ${cryptoModes.length}`);
  }
  const modeIds: string[] = [];
  for (const m of cryptoModes) {
    const id = getString(m, 'mode_id');
    modeIds.push(id);
    if (!/^MOD_CRYPTO_[A-Z]+$/.test(id)) {
      push(`MODERATION_TAXONOMY: malformed crypto mode id "${id}"`);
    }
  }
  if (!unique(modeIds)) {
    push(`MODERATION_TAXONOMY: crypto mode ids not unique: ${duplicates(modeIds).join(', ')}`);
  }

  // Reason codes
  const reasonCodes = records(getArray(doc.json, 'reason_codes'));
  const validParents = new Set([...categoryIds, ...modeIds]);
  const codeIds: string[] = [];
  const codesPerCategory = new Map<string, number>();
  for (const rc of reasonCodes) {
    const code = getString(rc, 'reason_code');
    const cat = getString(rc, 'category_id');
    const sev = getString(rc, 'severity_default');
    const sla = getString(rc, 'sla_target');
    const appealable = getBool(rc, 'appealable');
    codeIds.push(code);
    codesPerCategory.set(cat, (codesPerCategory.get(cat) ?? 0) + 1);
    if (!/^MOD_[A-Z_]+_\d{3}$/.test(code)) {
      push(`MODERATION_TAXONOMY: malformed reason code "${code}"`);
    }
    if (!validParents.has(cat)) {
      push(`MODERATION_TAXONOMY: reason code "${code}" references unknown category "${cat}"`);
    } else if (!code.startsWith(`${cat}_`)) {
      push(`MODERATION_TAXONOMY: reason code "${code}" does not live under namespace "${cat}_*"`);
    }
    if (SLA_BY_SEVERITY[sev] === undefined) {
      push(`MODERATION_TAXONOMY: reason code "${code}" has unknown severity "${sev}"`);
    } else if (SLA_BY_SEVERITY[sev] !== sla) {
      push(
        `MODERATION_TAXONOMY: reason code "${code}" SLA "${sla}" != "${SLA_BY_SEVERITY[sev]}" for ${sev}`,
      );
    }
    if (appealable === null) {
      push(`MODERATION_TAXONOMY: reason code "${code}" missing boolean "appealable"`);
    }
  }
  if (!unique(codeIds)) {
    push(`MODERATION_TAXONOMY: reason codes not unique: ${duplicates(codeIds).join(', ')}`);
  }
  for (const cat of categoryIds) {
    if ((codesPerCategory.get(cat) ?? 0) < 3) {
      push(`MODERATION_TAXONOMY: category "${cat}" has fewer than 3 representative reason codes`);
    }
  }
  for (const mode of modeIds) {
    if ((codesPerCategory.get(mode) ?? 0) < 1) {
      push(`MODERATION_TAXONOMY: crypto mode "${mode}" has no reason code in the enumeration`);
    }
  }

  // Appeal eligibility
  const appeals = records(getArray(doc.json, 'appeal_eligibility'));
  let hasNonAppealable = false;
  for (const a of appeals) {
    if (getBool(a, 'appealable') === false) hasNonAppealable = true;
  }
  if (!hasNonAppealable) {
    push('MODERATION_TAXONOMY: appeal-eligibility matrix lacks the non-appealable exception row');
  }

  // Prose <-> machine-readable consistency for the full MOD_* id space.
  const allModIds = [...categoryIds, ...modeIds, ...codeIds];
  checkProsePresence(doc, allModIds, push);
  checkProseTokens(doc, /MOD_[A-Z]+(?:_[A-Z]+)*(?:_\d{3})?/g, new Set(allModIds), push);
}

function validateTransparencyDictionary(doc: PolicyDoc, push: Push): void {
  if (!doc.json) return;
  const product = records(getArray(doc.json, 'product_health_metrics'));
  const knomosis = records(getArray(doc.json, 'knomosis_metrics'));
  const anti = records(getArray(doc.json, 'anti_metrics'));

  if (product.length !== 13)
    push(`TRANSPARENCY_DICTIONARY: expected 13 product-health metrics, found ${product.length}`);
  if (knomosis.length !== 8)
    push(`TRANSPARENCY_DICTIONARY: expected 8 Knomosis metrics, found ${knomosis.length}`);
  if (anti.length !== 11)
    push(`TRANSPARENCY_DICTIONARY: expected 11 anti-metrics, found ${anti.length}`);

  const ids: string[] = [];
  for (const m of product) {
    const id = getString(m, 'metric_id');
    ids.push(id);
    if (!/^TM-[A-Z]+$/.test(id))
      push(`TRANSPARENCY_DICTIONARY: malformed product metric id "${id}"`);
    if (getString(m, 'privacy_threshold') === '') {
      push(`TRANSPARENCY_DICTIONARY: metric "${id}" missing privacy_threshold`);
    }
  }
  for (const m of knomosis) {
    const id = getString(m, 'metric_id');
    ids.push(id);
    if (!/^KM-[A-Z0-9]+$/.test(id))
      push(`TRANSPARENCY_DICTIONARY: malformed Knomosis metric id "${id}"`);
    if (getString(m, 'guards_against') === '') {
      push(`TRANSPARENCY_DICTIONARY: metric "${id}" missing guards_against`);
    }
  }
  for (const blocker of ['KM-P2RLEAK', 'KM-RECONGAP']) {
    const m = knomosis.find((k) => getString(k, 'metric_id') === blocker);
    if (!m) {
      push(`TRANSPARENCY_DICTIONARY: missing expansion-blocking metric "${blocker}"`);
    } else if (getBool(m, 'expansion_blocking') !== true) {
      push(`TRANSPARENCY_DICTIONARY: metric "${blocker}" must be expansion_blocking=true`);
    }
  }
  for (const m of anti) {
    const id = getString(m, 'anti_metric_id');
    ids.push(id);
    if (!/^AM-[A-Z]+$/.test(id)) push(`TRANSPARENCY_DICTIONARY: malformed anti-metric id "${id}"`);
  }
  if (!anti.some((m) => getString(m, 'anti_metric_id') === 'AM-ENGAGEONLY')) {
    push('TRANSPARENCY_DICTIONARY: missing AM-ENGAGEONLY (engagement-alone prohibition)');
  }
  if (!unique(ids))
    push(`TRANSPARENCY_DICTIONARY: metric ids not unique: ${duplicates(ids).join(', ')}`);

  checkProsePresence(doc, ids, push);
  checkProseTokens(doc, /\b(?:TM|KM|AM)-[A-Z0-9]+/g, new Set(ids), push);
}

function validateSignalTestMap(doc: PolicyDoc, push: Push): void {
  if (!doc.json) return;
  const signalTests = records(getArray(doc.json, 'signal_tests'));
  const suiteTests = records(getArray(doc.json, 'suite_tests'));

  if (signalTests.length !== 14)
    push(`SIGNAL_TEST_MAP: expected 14 signal-level tests, found ${signalTests.length}`);
  if (suiteTests.length !== 4)
    push(`SIGNAL_TEST_MAP: expected 4 suite-level tests, found ${suiteTests.length}`);

  const methods = new Set(['feed-replay', 'schema-audit', 'feature-inspection', 'integration']);
  const freqs = new Set(['CI', 'pre-release', 'post-release']);
  const rntIds: string[] = [];
  const signalIds: string[] = [];
  const suiteIds: string[] = [];
  for (const t of signalTests) {
    const rnt = getString(t, 'rnt_id');
    const sig = getString(t, 'signal_id');
    const suite = getString(t, 'suite_test');
    rntIds.push(rnt);
    signalIds.push(sig);
    suiteIds.push(suite);
    if (!/^RNT-\d{3}$/.test(rnt)) push(`SIGNAL_TEST_MAP: malformed RNT id "${rnt}"`);
    if (!/^SIG-PROH-[A-Z]+$/.test(sig))
      push(`SIGNAL_TEST_MAP: test "${rnt}" references non-prohibited signal "${sig}"`);
    if (!/^WS-I\.3\.1[a-z]$/.test(suite))
      push(`SIGNAL_TEST_MAP: test "${rnt}" malformed suite test "${suite}"`);
    if (!methods.has(getString(t, 'method')))
      push(`SIGNAL_TEST_MAP: test "${rnt}" has unknown method`);
    if (!freqs.has(getString(t, 'frequency')))
      push(`SIGNAL_TEST_MAP: test "${rnt}" has unknown frequency`);
    if (getString(t, 'failure_action') === '')
      push(`SIGNAL_TEST_MAP: test "${rnt}" missing failure_action`);
  }
  if (!unique(rntIds))
    push(`SIGNAL_TEST_MAP: RNT ids not unique: ${duplicates(rntIds).join(', ')}`);
  if (!unique(signalIds))
    push(`SIGNAL_TEST_MAP: signal ids not unique: ${duplicates(signalIds).join(', ')}`);

  const expectedSuite = new Set(['WS-I.3.1g', 'WS-I.3.1h', 'WS-I.3.1i', 'WS-I.3.1j']);
  for (const s of suiteTests) {
    const id = getString(s, 'suite_test');
    if (!expectedSuite.has(id)) push(`SIGNAL_TEST_MAP: unexpected suite-level test "${id}"`);
  }

  checkProsePresence(doc, [...rntIds, ...signalIds], push);
  checkProseTokens(doc, /RNT-\d{3}/g, new Set(rntIds), push);
  checkProseTokens(doc, /SIG-PROH-[A-Z]+/g, new Set(signalIds), push);
}

function validateStewardRoles(doc: PolicyDoc, push: Push): void {
  if (!doc.json) return;
  const roles = records(getArray(doc.json, 'roles'));
  if (roles.length !== 5) push(`STEWARD_ROLES: expected 5 roles, found ${roles.length}`);

  const expected = new Set([
    'ROLE_COMMUNITY',
    'ROLE_EVIDENCE',
    'ROLE_SAFETY',
    'ROLE_APPEALS',
    'ROLE_INTEGRITY',
  ]);
  const ids: string[] = [];
  const actionsByRole = new Map<string, string[]>();
  for (const r of roles) {
    const id = getString(r, 'role_id');
    ids.push(id);
    actionsByRole.set(id, getStringArray(r, 'actions'));
    if (!/^ROLE_[A-Z]+$/.test(id)) push(`STEWARD_ROLES: malformed role id "${id}"`);
    if (!expected.has(id)) push(`STEWARD_ROLES: unexpected role id "${id}"`);
    if (getStringArray(r, 'actions').length === 0)
      push(`STEWARD_ROLES: role "${id}" has no actions`);
  }
  if (!unique(ids)) push(`STEWARD_ROLES: role ids not unique: ${duplicates(ids).join(', ')}`);
  for (const id of expected) {
    if (!ids.includes(id)) push(`STEWARD_ROLES: missing required role "${id}"`);
  }

  // Least-privilege separation of duties.
  const exclusive: Record<string, string> = {
    remove: 'ROLE_SAFETY',
    restrict: 'ROLE_SAFETY',
    ban: 'ROLE_SAFETY',
    overturn: 'ROLE_APPEALS',
    modify: 'ROLE_APPEALS',
    'treasury-freeze': 'ROLE_INTEGRITY',
    'room-governance-freeze': 'ROLE_INTEGRITY',
  };
  for (const [action, owner] of Object.entries(exclusive)) {
    for (const [roleId, actions] of actionsByRole) {
      if (actions.includes(action) && roleId !== owner) {
        push(
          `STEWARD_ROLES: action "${action}" must be exclusive to ${owner}, also granted to ${roleId}`,
        );
      }
    }
  }

  checkProsePresence(doc, ids, push);
  checkProseTokens(doc, /ROLE_[A-Z]+/g, new Set(ids), push);
}

function validateCryptoMatrix(doc: PolicyDoc, push: Push): void {
  if (!doc.json) return;
  const tiers = records(getArray(doc.json, 'tiers'));
  if (tiers.length !== 5) push(`CRYPTO_FEATURE_MATRIX: expected 5 tiers, found ${tiers.length}`);
  const expected = ['CRYPTO_T0', 'CRYPTO_T1', 'CRYPTO_T2', 'CRYPTO_T3', 'CRYPTO_T4'];
  const ids: string[] = [];
  for (const t of tiers) {
    const id = getString(t, 'tier_id');
    const state = getString(t, 'default_state');
    ids.push(id);
    if (!expected.includes(id)) push(`CRYPTO_FEATURE_MATRIX: unexpected tier id "${id}"`);
    const expectState = id === 'CRYPTO_T0' ? 'enabled' : 'disabled';
    if (state !== expectState) {
      push(
        `CRYPTO_FEATURE_MATRIX: tier "${id}" default_state "${state}" violates fail-closed (expected "${expectState}")`,
      );
    }
  }
  for (const id of expected) {
    if (!ids.includes(id)) push(`CRYPTO_FEATURE_MATRIX: missing tier "${id}"`);
  }
  const reqs = getStringArray(doc.json, 'per_tier_requirements');
  if (reqs.length !== 10)
    push(`CRYPTO_FEATURE_MATRIX: expected 10 per-tier requirements, found ${reqs.length}`);
  if (getBool(doc.json, 'core_social_independent') !== true) {
    push('CRYPTO_FEATURE_MATRIX: core_social_independent must be true');
  }

  checkProsePresence(doc, ids, push);
  checkProsePresence(doc, reqs, push);
  checkProseTokens(doc, /CRYPTO_T[0-9]/g, new Set(ids), push);
}

function validateJurisdictionMatrix(doc: PolicyDoc, push: Push): void {
  if (!doc.json) return;
  const vocab = getStringArray(doc.json, 'cell_vocabulary');
  const expectedVocab = ['enabled', 'disabled', 'simulated', 'testnet', 'pending-legal', 'blocked'];
  if (
    new Set(vocab).size !== expectedVocab.length ||
    !expectedVocab.every((v) => vocab.includes(v))
  ) {
    push(`JURISDICTION_MATRIX: cell vocabulary must be exactly [${expectedVocab.join(', ')}]`);
  }
  const features = records(getArray(doc.json, 'feature_categories'));
  if (features.length !== 8)
    push(`JURISDICTION_MATRIX: expected 8 feature categories, found ${features.length}`);
  const fields = getStringArray(doc.json, 'jurisdiction_row_fields');
  for (const req of [
    'region_code',
    'legal_review_status',
    'kyc_aml_triggers',
    'sanctions_posture',
    'age_assurance_requirement',
    'disabled_region_fallback_ux_ref',
  ]) {
    if (!fields.includes(req))
      push(`JURISDICTION_MATRIX: missing required jurisdiction-row field "${req}"`);
  }
  const states = getStringArray(doc.json, 'legal_review_states');
  for (const s of ['pending', 'in-progress', 'approved', 'blocked']) {
    if (!states.includes(s)) push(`JURISDICTION_MATRIX: missing legal_review_state "${s}"`);
  }
  for (const v of expectedVocab) checkProsePresence(doc, [v], push);
}

function validatePrivacyMap(doc: PolicyDoc, push: Push): void {
  if (!doc.json) return;
  const regs = getStringArray(doc.json, 'regulations');
  for (const r of ['GDPR', 'CCPA/CPRA', 'COPPA']) {
    if (!regs.includes(r)) push(`PRIVACY_REGULATION_MAP: missing regulation "${r}"`);
  }
  const categories = records(getArray(doc.json, 'data_categories'));
  if (categories.length !== 6)
    push(`PRIVACY_REGULATION_MAP: expected 6 data categories, found ${categories.length}`);
  if (getBool(doc.json, 'minors_excluded_from_financial_features') !== true) {
    push('PRIVACY_REGULATION_MAP: minors_excluded_from_financial_features must be true');
  }
  if (getBool(doc.json, 'never_sells_attention_data') !== true) {
    push('PRIVACY_REGULATION_MAP: never_sells_attention_data must be true');
  }
  if (getBool(doc.json, 'behavioral_advertising') !== false) {
    push('PRIVACY_REGULATION_MAP: behavioral_advertising must be false');
  }
  const rights = records(getArray(doc.json, 'user_rights_endpoints'));
  const rightLabels = rights.map((r) => getString(r, 'right'));
  for (const required of [
    'View Signal Ledger',
    'Export account data',
    'Delete attention history',
  ]) {
    if (!rightLabels.includes(required))
      push(`PRIVACY_REGULATION_MAP: missing user right "${required}"`);
  }
}

// --- Cross-document validators ---------------------------------------------------------

function validateCrossDoc(docs: Map<string, PolicyDoc>, push: Push): void {
  const signal = docs.get('SIGNAL_MATRIX')?.json;
  const testMap = docs.get('SIGNAL_TEST_MAP')?.json;
  const steward = docs.get('STEWARD_ROLES')?.json;
  const moderation = docs.get('MODERATION_TAXONOMY');
  const crypto = docs.get('CRYPTO_FEATURE_MATRIX')?.json;
  const jurisdiction = docs.get('JURISDICTION_MATRIX')?.json;
  const transparency = docs.get('TRANSPARENCY_DICTIONARY');

  // 1. Bijective RNT <-> signal <-> suite between SIGNAL_MATRIX and SIGNAL_TEST_MAP.
  if (signal && testMap) {
    const prohibited = records(getArray(signal, 'signals')).filter(
      (s) => getString(s, 'kind') === 'prohibited',
    );
    const matrixById = new Map<string, { rnt: string; suite: string }>();
    for (const s of prohibited) {
      matrixById.set(getString(s, 'id'), {
        rnt: getString(s, 'rnt'),
        suite: getString(s, 'suite'),
      });
    }
    const tests = records(getArray(testMap, 'signal_tests'));
    const testById = new Map<string, { rnt: string; suite: string }>();
    for (const t of tests) {
      testById.set(getString(t, 'signal_id'), {
        rnt: getString(t, 'rnt_id'),
        suite: getString(t, 'suite_test'),
      });
    }
    if (matrixById.size !== testById.size) {
      push(
        `CROSS: prohibited-signal count (${matrixById.size}) != signal-test count (${testById.size})`,
      );
    }
    for (const [id, m] of matrixById) {
      const t = testById.get(id);
      if (!t) {
        push(`CROSS: prohibited signal "${id}" has no matching RNT test in SIGNAL_TEST_MAP`);
        continue;
      }
      if (t.rnt !== m.rnt || t.suite !== m.suite) {
        push(
          `CROSS: mapping drift for "${id}": matrix(${m.rnt}->${m.suite}) vs test(${t.rnt}->${t.suite})`,
        );
      }
    }
    for (const id of testById.keys()) {
      if (!matrixById.has(id))
        push(`CROSS: SIGNAL_TEST_MAP test references unknown prohibited signal "${id}"`);
    }
  }

  // 2. Moderation appeal reviewers + prose role tokens resolve to defined steward roles.
  if (steward && moderation?.json) {
    const roleIds = new Set(
      records(getArray(steward, 'roles')).map((r) => getString(r, 'role_id')),
    );
    for (const a of records(getArray(moderation.json, 'appeal_eligibility'))) {
      const roleId = getString(a, 'role_id');
      if (roleId !== '' && !roleIds.has(roleId)) {
        push(
          `CROSS: appeal action "${getString(a, 'action_type')}" reviewer "${roleId}" is not a defined steward role`,
        );
      }
    }
    for (const match of moderation.prose.matchAll(/ROLE_[A-Z]+/g)) {
      if (!roleIds.has(match[0])) {
        push(`CROSS: MODERATION_TAXONOMY references undefined steward role "${match[0]}"`);
      }
    }
  }

  // 3. Crypto tier default states are members of the jurisdiction cell vocabulary.
  if (crypto && jurisdiction) {
    const vocab = new Set(getStringArray(jurisdiction, 'cell_vocabulary'));
    for (const t of records(getArray(crypto, 'tiers'))) {
      const state = getString(t, 'default_state');
      if (!vocab.has(state)) {
        push(
          `CROSS: crypto tier "${getString(t, 'tier_id')}" default_state "${state}" not in jurisdiction vocabulary`,
        );
      }
    }
  }

  // 4. Transparency safety breakdowns reference the moderation taxonomy reason codes.
  if (transparency && !transparency.prose.includes('MODERATION_TAXONOMY')) {
    push(
      'CROSS: TRANSPARENCY_DICTIONARY safety breakdowns must reference MODERATION_TAXONOMY reason codes',
    );
  }
}

// --- Entry point -----------------------------------------------------------------------

export function validatePolicyDocs(dir: string): string[] {
  const errors: string[] = [];
  const push: Push = (msg) => errors.push(msg);
  const docs = loadDocs(dir);

  for (const doc of docs.values()) {
    if (doc.jsonError) {
      push(`${doc.name}: ${doc.jsonError}`);
    } else {
      requireHeaderFields(doc, push);
    }
  }

  const signalMatrix = docs.get('SIGNAL_MATRIX');
  if (signalMatrix) validateSignalMatrix(signalMatrix, push);
  const moderation = docs.get('MODERATION_TAXONOMY');
  if (moderation) validateModerationTaxonomy(moderation, push);
  const transparency = docs.get('TRANSPARENCY_DICTIONARY');
  if (transparency) validateTransparencyDictionary(transparency, push);
  const testMap = docs.get('SIGNAL_TEST_MAP');
  if (testMap) validateSignalTestMap(testMap, push);
  const steward = docs.get('STEWARD_ROLES');
  if (steward) validateStewardRoles(steward, push);
  const crypto = docs.get('CRYPTO_FEATURE_MATRIX');
  if (crypto) validateCryptoMatrix(crypto, push);
  const jurisdiction = docs.get('JURISDICTION_MATRIX');
  if (jurisdiction) validateJurisdictionMatrix(jurisdiction, push);
  const privacy = docs.get('PRIVACY_REGULATION_MAP');
  if (privacy) validatePrivacyMap(privacy, push);

  validateCrossDoc(docs, push);

  return errors;
}

export const POLICY_FILES = FILES;
