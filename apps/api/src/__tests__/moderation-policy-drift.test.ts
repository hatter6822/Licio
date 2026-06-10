// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drift guard between the moderation event schema (WS-E.1.1d) and the WS-A
// policy SSOT (docs/policy/MODERATION_TAXONOMY.md). The schema validates
// reason-code SHAPE + category membership at runtime; this test closes the
// remaining drift window by asserting, against the policy document's canonical
// JSON block, that (a) every published reason code parses, and (b) the twelve
// category namespaces match MODERATION_CATEGORY_IDS exactly — so neither side
// can change without this failing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODERATION_CATEGORY_IDS, moderationReasonCodeSchema } from '@licio/shared';
import { describe, expect, it } from 'vitest';

const TAXONOMY_PATH = fileURLToPath(
  new URL('../../../../docs/policy/MODERATION_TAXONOMY.md', import.meta.url),
);

interface CanonicalTaxonomy {
  categories: Array<{ category_id: string }>;
  reason_codes: Array<{ category_id: string; reason_code: string }>;
}

function loadCanonicalTaxonomy(): CanonicalTaxonomy {
  const markdown = readFileSync(TAXONOMY_PATH, 'utf8');
  const match = markdown.match(/```json\n([\s\S]*?)\n```/);
  if (!match?.[1]) throw new Error('MODERATION_TAXONOMY.md canonical JSON block not found');
  return JSON.parse(match[1]) as CanonicalTaxonomy;
}

describe('moderation reason codes vs the WS-A policy SSOT', () => {
  const taxonomy = loadCanonicalTaxonomy();

  it('every published §18.1 reason code parses through the event schema', () => {
    // MOD_CRYPTO_* codes are the Knomosis-plane abuse taxonomy (WS-A.1.2d);
    // crypto abuse cases flow through `compliance.financial.case.created`,
    // not the §18.1 `moderation.case.created` topic — so they are deliberately
    // outside this schema.
    const contentCodes = taxonomy.reason_codes.filter(
      (c) => !c.category_id.startsWith('MOD_CRYPTO'),
    );
    expect(contentCodes.length).toBeGreaterThanOrEqual(36); // 12 × >=3
    for (const { reason_code } of contentCodes) {
      expect(
        moderationReasonCodeSchema.safeParse(reason_code).success,
        `policy code ${reason_code} must parse`,
      ).toBe(true);
    }
  });

  it('the schema category namespaces match the policy categories exactly', () => {
    const policyCategories = taxonomy.categories
      .map((c) => c.category_id)
      // The crypto abuse-mode namespace (MOD_CRYPTO_*) is a Knomosis-plane
      // taxonomy (WS-A.1.2d), not a SPEC §18.1 content category.
      .filter((id) => !id.startsWith('MOD_CRYPTO'));
    expect([...policyCategories].sort()).toEqual([...MODERATION_CATEGORY_IDS].sort());
  });

  it('every reason code namespace is one of the policy categories', () => {
    for (const { category_id, reason_code } of taxonomy.reason_codes) {
      if (category_id.startsWith('MOD_CRYPTO')) continue;
      expect(reason_code.startsWith(`${category_id}_`), reason_code).toBe(true);
    }
  });
});
