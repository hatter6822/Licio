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
import { join, resolve } from 'node:path';

// --- Shared shapes ---------------------------------------------------------------------

export interface PolicyDoc {
  name: string;
  fileName: string;
  raw: string;
  prose: string;
  json: Record<string, unknown> | null;
  jsonError: string | null;
}

// NOT `Record<string, string>`: that annotation threw away the keys, so every
// `POLICY_FILES.SIGNAL_MATRIX` became an index-signature read of type
// `string | undefined` — twelve bracket-access errors and eleven
// possibly-undefined arguments, all of them the annotation's doing rather than
// anything about the data.
const FILES = {
  SIGNAL_MATRIX: 'SIGNAL_MATRIX.md',
  MODERATION_TAXONOMY: 'MODERATION_TAXONOMY.md',
  TRANSPARENCY_DICTIONARY: 'TRANSPARENCY_DICTIONARY.md',
  SIGNAL_TEST_MAP: 'SIGNAL_TEST_MAP.md',
  STEWARD_ROLES: 'STEWARD_ROLES.md',
  CRYPTO_FEATURE_MATRIX: 'CRYPTO_FEATURE_MATRIX.md',
  JURISDICTION_MATRIX: 'JURISDICTION_MATRIX.md',
  PRIVACY_REGULATION_MAP: 'PRIVACY_REGULATION_MAP.md',
} as const;

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
  for (const s of byKind['prohibited'] ?? []) {
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

  for (const s of byKind['anti'] ?? []) {
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

  // Moderation layers (WS-A.1.2b)
  const layers = records(getArray(doc.json, 'layers'));
  const layerNames = layers.map((l) => getString(l, 'layer'));
  if (layerNames.length !== 6) {
    push(`MODERATION_TAXONOMY: expected 6 moderation layers, found ${layerNames.length}`);
  }
  for (const l of layers) {
    if (getStringArray(l, 'operated_by').length === 0) {
      push(`MODERATION_TAXONOMY: layer "${getString(l, 'layer')}" has no operated_by role(s)`);
    }
    if (getString(l, 'escalation_trigger') === '') {
      push(`MODERATION_TAXONOMY: layer "${getString(l, 'layer')}" has no escalation_trigger`);
    }
  }
  checkProsePresence(doc, layerNames, push);

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
    if (getString(m, 'aggregation') === '') {
      push(`TRANSPARENCY_DICTIONARY: metric "${id}" missing aggregation method`);
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
    if (getString(m, 'aggregation') === '') {
      push(`TRANSPARENCY_DICTIONARY: metric "${id}" missing aggregation method`);
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

  // Exemplar-row composition: fail-closed + no crypto cell enabled without legal approval.
  const vocabSet = new Set(vocab);
  const cryptoCells = new Set(getStringArray(doc.json, 'crypto_feature_cells'));
  for (const row of records(getArray(doc.json, 'exemplar_rows'))) {
    const region = getString(row, 'region_code');
    const legalStatus = getString(row, 'legal_review_status');
    const cells = isRecord(row['cells']) ? row['cells'] : {};
    if (getString(cells, 'core_social') !== 'enabled') {
      push(
        `JURISDICTION_MATRIX: exemplar row "${region}" must keep core_social enabled (invariant 8)`,
      );
    }
    for (const [feature, raw] of Object.entries(cells)) {
      const value = typeof raw === 'string' ? raw : '';
      if (!vocabSet.has(value)) {
        push(
          `JURISDICTION_MATRIX: exemplar row "${region}" cell "${feature}" value "${value}" not in vocabulary`,
        );
      }
      if (cryptoCells.has(feature) && value === 'enabled' && legalStatus !== 'approved') {
        push(
          `JURISDICTION_MATRIX: exemplar row "${region}" enables crypto cell "${feature}" without approved legal review (fail-closed violation)`,
        );
      }
    }
  }
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

  // SPEC §19.2 attention-signal handling rows must each carry a default handling.
  const handling = records(getArray(doc.json, 'attention_signal_handling'));
  if (handling.length !== 7) {
    push(`PRIVACY_REGULATION_MAP: expected 7 SPEC §19.2 handling rows, found ${handling.length}`);
  }
  for (const h of handling) {
    if (getString(h, 'default_handling') === '') {
      push(
        `PRIVACY_REGULATION_MAP: handling row "${getString(h, 'data')}" missing default_handling`,
      );
    }
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
      const action = getString(a, 'action_type');
      for (const key of ['role_id', 'then_role_id']) {
        const roleId = getString(a, key);
        if (roleId !== '' && !roleIds.has(roleId)) {
          push(`CROSS: appeal action "${action}" ${key} "${roleId}" is not a defined steward role`);
        }
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

// --- SPEC cross-validation -------------------------------------------------------------
//
// The WS-A plan's "Testing" sections are mostly SPEC cross-references. These helpers parse
// docs/SPEC.md so the policy documents are pinned to their authoritative source, not just
// to hard-coded constants. SPEC v0.6 duplicates some headings/tables; the parsers dedupe.

function specSection(spec: string, idLabel: string): string {
  const lines = spec.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line === `## ${idLabel}` || line.startsWith(`## ${idLabel} `)) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';
  const startLine = lines[start] ?? '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // Stop at the next distinct level-1/2 heading (skip duplicated headings).
    if (/^#{1,2} /.test(line) && line !== startLine) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function specSubsection(sectionText: string, titleIncludes: string): string {
  for (const chunk of sectionText.split('\n### ')) {
    if (chunk.includes(titleIncludes)) return chunk;
  }
  return '';
}

function tableFirstColumn(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    if (/^\|[\s:|-]+\|?$/.test(line)) continue;
    const first = (line.split('|')[1] ?? '').trim();
    if (first) out.push(first);
  }
  if (out.length === 0) return [];
  const header = out[0];
  return [...new Set(out.filter((v) => v !== header))];
}

function setEqual(a: string[], b: string[]): boolean {
  const sb = new Set(b);
  const sa = new Set(a);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

function setDiff(a: string[], b: string[]): string[] {
  const sb = new Set(b);
  return [...new Set(a)].filter((v) => !sb.has(v));
}

function jsonNames(doc: PolicyDoc | undefined, key: string, field: string): string[] {
  if (!doc?.json) return [];
  return records(getArray(doc.json, key)).map((r) => getString(r, field));
}

function checkSpecSetEqual(
  label: string,
  docNames: string[],
  specNames: string[],
  push: Push,
): void {
  if (specNames.length === 0) {
    push(`SPEC ${label}: could not extract the reference set from SPEC.md`);
    return;
  }
  if (!setEqual(docNames, specNames)) {
    const missing = setDiff(specNames, docNames);
    const extra = setDiff(docNames, specNames);
    const missingMsg = missing.length
      ? ` | in SPEC, missing from doc: [${missing.join(', ')}]`
      : '';
    const extraMsg = extra.length ? ` | in doc, not in SPEC: [${extra.join(', ')}]` : '';
    push(`SPEC ${label}: doc and SPEC disagree${missingMsg}${extraMsg}`);
  }
}

function requireSpecKeywords(spec: string, idLabel: string, keywords: string[], push: Push): void {
  const body = specSection(spec, idLabel).toLowerCase();
  if (body === '') {
    push(`SPEC §${idLabel}: section not found`);
    return;
  }
  for (const kw of keywords) {
    if (!body.includes(kw.toLowerCase())) {
      push(`SPEC §${idLabel}: expected anchor term "${kw}" is absent (doc/SPEC drift?)`);
    }
  }
}

function validateAgainstSpec(docs: Map<string, PolicyDoc>, spec: string, push: Push): void {
  // §5.3 signal categories — names must match SPEC tables exactly.
  const s53 = specSection(spec, '5.3');
  const sm = docs.get('SIGNAL_MATRIX')?.json;
  if (sm) {
    const signals = records(getArray(sm, 'signals'));
    const namesByKind = (kind: string): string[] =>
      signals.filter((x) => getString(x, 'kind') === kind).map((x) => getString(x, 'name'));
    checkSpecSetEqual(
      '§5.3 attention',
      namesByKind('attention'),
      tableFirstColumn(specSubsection(s53, 'Attention signals')),
      push,
    );
    checkSpecSetEqual(
      '§5.3 participation',
      namesByKind('participation'),
      tableFirstColumn(specSubsection(s53, 'Participation signals')),
      push,
    );
    checkSpecSetEqual(
      '§5.3 anti-signals',
      namesByKind('anti'),
      tableFirstColumn(specSubsection(s53, 'Anti-signals')),
      push,
    );
  }

  // §13.6 ranking prohibitions — anchor the prohibited-signal list.
  requireSpecKeywords(
    spec,
    '13.6',
    [
      'likes',
      'upvotes',
      'wallet connection',
      'token balance',
      'donation amount',
      'treasury contribution',
      'payment receipt',
      'governance vote',
      'paid membership',
    ],
    push,
  );

  // §16.3 steward roles — set equality.
  checkSpecSetEqual(
    '§16.3 steward roles',
    jsonNames(docs.get('STEWARD_ROLES'), 'roles', 'name'),
    tableFirstColumn(specSection(spec, '16.3')),
    push,
  );

  // §18.1 categories (anchor), §18.2 layers (set equal), §18.5 crypto modes (anchor).
  requireSpecKeywords(
    spec,
    '18.1',
    [
      'illegal content',
      'threats',
      'harassment',
      'hate',
      'sexual exploitation',
      'graphic',
      'misinformation',
      'impersonation',
      'spam',
      'privacy violations',
      'synthetic-media',
      'intellectual-property',
    ],
    push,
  );
  checkSpecSetEqual(
    '§18.2 moderation layers',
    jsonNames(docs.get('MODERATION_TAXONOMY'), 'layers', 'layer'),
    tableFirstColumn(specSection(spec, '18.2')),
    push,
  );
  requireSpecKeywords(
    spec,
    '18.5',
    [
      'wallet-drainer',
      'signature prompts',
      'impersonation',
      'bounty collusion',
      'vote buying',
      'bribery',
      'treasury capture',
      'sanctions evasion',
      'report-abuse',
      'disinformation',
      'investment claims',
      'fraudulent grants',
      'fabricated invoices',
      'dao votes to reveal',
    ],
    push,
  );

  // §28.1 product metrics (anchor), §28.3 Knomosis (set equal), §28.2/§28.3 anti-metrics.
  requireSpecKeywords(
    spec,
    '28.1',
    [
      'constructive-participation rate',
      'source-open rate',
      'evidence-addition rate',
      'question-resolution rate',
      'meri distribution',
      'scoi reduction',
      'mfci incidents',
      'gwei cohort',
      'phi steering-risk',
      'harassment-protection latency',
      'appeal-overturn rate',
      'accessibility-defect rate',
      'core web vitals',
    ],
    push,
  );
  checkSpecSetEqual(
    '§28.3 Knomosis metrics',
    jsonNames(docs.get('TRANSPARENCY_DICTIONARY'), 'knomosis_metrics', 'name'),
    tableFirstColumn(specSection(spec, '28.3')),
    push,
  );
  requireSpecKeywords(
    spec,
    '28.2',
    ['likes, upvotes', 'follower leaderboards', 'rollback', 'invariant versions', 'engagement'],
    push,
  );
  requireSpecKeywords(
    spec,
    '28.3',
    [
      'total value locked',
      'tokens traded',
      'wallet connects',
      'speculative price',
      'treasury size',
    ],
    push,
  );

  // §30.6 neutrality suite — anchor the suite-level tests.
  requireSpecKeywords(
    spec,
    '30.6',
    [
      'feed replay',
      'payment amount',
      'paid membership',
      'sponsored',
      'ml feature audit',
      'dashboards separate',
      'public explanations',
    ],
    push,
  );

  // §17.11 crypto tiers/gates.
  requireSpecKeywords(
    spec,
    '17.11',
    ['simulated', 'testnet', 'capped', 'external audit', 'legal sign-off'],
    push,
  );

  // §19.2 attention-signal handling — set equality.
  checkSpecSetEqual(
    '§19.2 attention-signal handling',
    jsonNames(docs.get('PRIVACY_REGULATION_MAP'), 'attention_signal_handling', 'data'),
    tableFirstColumn(specSection(spec, '19.2')),
    push,
  );

  // §23.2 core endpoints — every cited endpoint must exist in the SPEC API list.
  const s232 = specSection(spec, '23.2');
  const privacy = docs.get('PRIVACY_REGULATION_MAP');
  if (privacy?.json) {
    for (const r of records(getArray(privacy.json, 'user_rights_endpoints'))) {
      const ep = getString(r, 'endpoint');
      const path = ep.replace(/^(?:GET|POST|PATCH|PUT|DELETE)\s+/, '');
      if (path !== '' && !s232.includes(path)) {
        push(`SPEC §23.2: endpoint "${ep}" is not in the SPEC core-endpoints list`);
      }
    }
  }
}

// --- Entry point -----------------------------------------------------------------------

export function validatePolicyDocs(dir: string, specPath?: string): string[] {
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

  // SPEC cross-validation: pin the documents to docs/SPEC.md, not just internal constants.
  const resolvedSpec = specPath ?? resolve(dir, '..', 'SPEC.md');
  let spec = '';
  try {
    spec = readFileSync(resolvedSpec, 'utf-8');
  } catch {
    push(`SPEC: could not read ${resolvedSpec} for cross-validation`);
  }
  if (spec !== '') validateAgainstSpec(docs, spec, push);

  return errors;
}

export const POLICY_FILES = FILES;
