// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.1b — the schema-level financial denylist at the feature-store write
// boundary (SPEC §13.6, §24.4, §30.6). Any feature vector (or any other
// ranking-stage record) carrying a field whose name matches a denied financial
// pattern is rejected with a typed `DeniedFinancialFieldError` before it can be
// persisted or scored. The term list is the SHARED WS-A.1.1 canonical denylist
// (`@licio/shared` FINANCIAL_FIELD_SEGMENTS / FINANCIAL_FIELD_COMPOUNDS), so
// the producer-side WS-F.2.5b content-schema assertion, the db-level checks,
// and this consumer-side gate can never drift apart.
//
// Matching is case-insensitive and segment-based (snake_case + camelCase), so
// nested/prefixed forms (`user_wallet_address`, `paymentAmountUsd`) are caught
// while benign words (`feed_mode`, `tokenized_text`) are not. The walk is
// recursive: a financial field hidden inside a nested object or an array
// element is still a financial field.

import {
  FINANCIAL_FIELD_COMPOUNDS,
  FINANCIAL_FIELD_SEGMENTS,
  fieldNameSegments,
  isFinancialFieldName,
} from '@licio/shared';
import denylistConfig from './denylist.config.json' with { type: 'json' };

/**
 * The versioned denylist ARTIFACT (WS-I.2.1b: "a versioned configuration
 * file, not inline code"). `denylist.config.json` is the reviewable record;
 * the shared WS-A.1.1 doctrine list in `@licio/shared` is the executable
 * source. The assertion below pins them to each other at module load: any
 * change to the matched pattern set requires editing BOTH in one reviewed
 * change (and bumping the artifact's `version`), or every consumer of this
 * module throws before a single feature can be written.
 */
export const RANKING_DENYLIST_VERSION: number = denylistConfig.version;

function assertArtifactMatchesDoctrine(): void {
  const artifactSegments = [...denylistConfig.segments].sort();
  const doctrineSegments = [...FINANCIAL_FIELD_SEGMENTS].sort();
  const artifactCompounds = [...denylistConfig.compounds].sort();
  const doctrineCompounds = [...FINANCIAL_FIELD_COMPOUNDS].sort();
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  if (!same(artifactSegments, doctrineSegments) || !same(artifactCompounds, doctrineCompounds)) {
    throw new Error(
      'ranking denylist drift: denylist.config.json does not match the shared ' +
        'WS-A.1.1 doctrine list (@licio/shared financial-fields). Update both ' +
        'in one reviewed change and bump the artifact version (WS-I.2.1b).',
    );
  }
}
assertArtifactMatchesDoctrine();

/**
 * The denied patterns, exposed as data for the neutrality suite (WS-I.3.1b/g)
 * and the CI snapshot that detects unreviewed denylist edits.
 */
export const RANKING_DENYLIST_PATTERNS: ReadonlyArray<{
  kind: 'segment' | 'compound';
  pattern: string;
}> = [
  ...FINANCIAL_FIELD_SEGMENTS.map((pattern) => ({ kind: 'segment' as const, pattern })),
  ...FINANCIAL_FIELD_COMPOUNDS.map((pattern) => ({ kind: 'compound' as const, pattern })),
];

/** A single denied-field finding (field path + which pattern matched). */
export interface DeniedFieldFinding {
  /** Dot path to the offending field (e.g. `metadata.user_wallet_address`). */
  path: string;
  /** The field name that matched. */
  field: string;
  /** The denied pattern that matched it. */
  matchedPattern: string;
  /** The denylist version in force. */
  denylistVersion: number;
}

/** Typed rejection raised at the feature-store write boundary (WS-I.2.1b). */
export class DeniedFinancialFieldError extends Error {
  readonly findings: readonly DeniedFieldFinding[];
  readonly denylistVersion = RANKING_DENYLIST_VERSION;

  constructor(findings: readonly DeniedFieldFinding[]) {
    const first = findings[0];
    super(
      first === undefined
        ? 'denied financial field'
        : `denied financial field "${first.path}" (matched pattern "${first.matchedPattern}", ` +
            `denylist v${RANKING_DENYLIST_VERSION})`,
    );
    this.name = 'DeniedFinancialFieldError';
    this.findings = findings;
  }
}

/** The pattern (segment or compound) that makes `name` financial, or null. */
export function matchedFinancialPattern(name: string): string | null {
  if (!isFinancialFieldName(name)) return null;
  // The SAME segmentation the shared matcher uses (single source of truth —
  // re-implementing the split here invited drift). Compounds are matched
  // against the normalized-segment join so camelCase multi-word financial
  // fields (e.g. txHash → tx_hash) cannot evade the compound containment.
  const segmentList = fieldNameSegments(name);
  const normalized = segmentList.join('_');
  for (const compound of FINANCIAL_FIELD_COMPOUNDS) {
    if (normalized.includes(compound)) return compound;
  }
  const segments = new Set(segmentList);
  for (const term of FINANCIAL_FIELD_SEGMENTS) {
    if (segments.has(term)) return term;
  }
  // isFinancialFieldName matched, so one of the branches above must have too.
  // A reached-here state means the two matchers have drifted — fail loudly
  // rather than silently mislabeling with a sentinel that is not a real match.
  throw new Error(`matchedFinancialPattern: isFinancialFieldName/pattern-loop drift for "${name}"`);
}

/**
 * Recursively scan an arbitrary record for denied field NAMES (values are
 * never inspected — the control is structural, on the shape). Arrays are
 * walked element-wise; cycles are guarded.
 */
export function findDeniedFields(value: unknown, basePath = ''): DeniedFieldFinding[] {
  const findings: DeniedFieldFinding[] = [];
  const seen = new Set<object>();
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) walk(node[i], `${path}[${i}]`);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      const matched = matchedFinancialPattern(key);
      if (matched !== null) {
        findings.push({
          path: childPath,
          field: key,
          matchedPattern: matched,
          denylistVersion: RANKING_DENYLIST_VERSION,
        });
      }
      walk(child, childPath);
    }
  };
  walk(value, basePath);
  return findings;
}

/**
 * Assert a record carries no denied financial field anywhere in its shape.
 * Throws {@link DeniedFinancialFieldError} listing EVERY offending field.
 */
export function assertNoDeniedFields(value: unknown): void {
  const findings = findDeniedFields(value);
  if (findings.length > 0) throw new DeniedFinancialFieldError(findings);
}

/**
 * Audit a list of feature-schema field names (WS-I.3.1g — the "ML feature
 * audit" boundary). Returns the offending names with matched patterns; empty
 * means the schema is financially clean.
 */
export function auditFeatureFieldNames(fieldNames: readonly string[]): DeniedFieldFinding[] {
  const findings: DeniedFieldFinding[] = [];
  for (const field of fieldNames) {
    const matched = matchedFinancialPattern(field);
    if (matched !== null) {
      findings.push({
        path: field,
        field,
        matchedPattern: matched,
        denylistVersion: RANKING_DENYLIST_VERSION,
      });
    }
  }
  return findings;
}
