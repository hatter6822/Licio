// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.1a/a-2 — the JurisdictionFeaturePolicy domain (SPEC §22.2, §17.10;
// docs/planning/15-compliance.md).  The cell vocabulary and the five crypto
// feature cells TRANSCRIBE the ratified docs/policy/JURISDICTION_MATRIX.md
// machine enumeration (WS-A.2.1) — a drift test asserts equality against the
// policy document, so the code can never diverge from the ratified artifact.
//
// Age gates are expressed in AGE BANDS, never ages: the platform stores no
// DOB (§19.4 minimization), so a minimum-age integer is structurally
// inexpressible here.  Region codes admit ISO 3166-1 alpha-2, sub-national
// codes (`US-CA`), and matrix grouping keys (`EU`).  Every sub-shape is
// `.strict()` so an unknown/injected key can never silently enable a feature.
import { z } from 'zod';
import { KNOMOSIS_ASSET_DECIMALS } from '../knomosis/assets.js';
import { isoTimestampSchema, uuidSchema } from './common.js';

/** The closed six-value cell vocabulary (`JURISDICTION_MATRIX.md`). */
export const JURISDICTION_CELL_STATES = [
  'enabled',
  'disabled',
  'simulated',
  'testnet',
  'pending-legal',
  'blocked',
] as const;
export type JurisdictionCellState = (typeof JURISDICTION_CELL_STATES)[number];
export const jurisdictionCellStateSchema = z.enum(JURISDICTION_CELL_STATES);

/** The five crypto feature cells (matrix `crypto_feature_cells`). */
export const CRYPTO_FEATURE_CELLS = [
  'wallet_connection',
  'testnet_transactions',
  'production_payments',
  'treasury_operations',
  'governance',
] as const;
export type CryptoFeatureCell = (typeof CRYPTO_FEATURE_CELLS)[number];
export const cryptoFeatureCellSchema = z.enum(CRYPTO_FEATURE_CELLS);

/** ISO 3166-1 alpha-2, a sub-national code (`US-CA`), or a grouping key (`EU`). */
export const regionCodeSchema = z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,62}[A-Z0-9]$/, {
  message: 'region code must be 2-64 uppercase letters/digits/hyphens (e.g. US, US-CA, EU)',
});

/** Exactly the five cells, each one closed-vocabulary value — no booleans. */
export const featureCellStatesSchema = z
  .object({
    wallet_connection: jurisdictionCellStateSchema,
    testnet_transactions: jurisdictionCellStateSchema,
    production_payments: jurisdictionCellStateSchema,
    treasury_operations: jurisdictionCellStateSchema,
    governance: jurisdictionCellStateSchema,
  })
  .strict();
export type FeatureCellStates = z.infer<typeof featureCellStatesSchema>;

/** The fail-closed default cell set (the matrix `XX` exemplar row). */
export const ALL_DISABLED_CELLS: FeatureCellStates = {
  wallet_connection: 'disabled',
  testnet_transactions: 'disabled',
  production_payments: 'disabled',
  treasury_operations: 'disabled',
  governance: 'disabled',
};

// ---------------------------------------------------------------------------
// Age gates — BAND-based (§19.4: no DOB exists to evaluate an age against).
// `adult` is the only band a crypto cell may require (a literal, so no other
// band — and no integer — is expressible).  `assurance: 'kyc_partner'` marks a
// jurisdiction that additionally requires VERIFIED age above the band.
// ---------------------------------------------------------------------------

export const AGE_GATE_ASSURANCES = ['kyc_partner'] as const;
export type AgeGateAssurance = (typeof AGE_GATE_ASSURANCES)[number];

export const ageGateCellSchema = z
  .object({
    required_band: z.literal('adult'),
    assurance: z.enum(AGE_GATE_ASSURANCES).optional(),
  })
  .strict();
export type AgeGateCell = z.infer<typeof ageGateCellSchema>;

export const ageGatePolicySchema = z
  .object({
    wallet_connection: ageGateCellSchema,
    testnet_transactions: ageGateCellSchema,
    production_payments: ageGateCellSchema,
    treasury_operations: ageGateCellSchema,
    governance: ageGateCellSchema,
  })
  .strict();
export type AgeGatePolicy = z.infer<typeof ageGatePolicySchema>;

/** The §19.4 default: every crypto cell requires the `adult` band. */
export const DEFAULT_AGE_GATE_POLICY: AgeGatePolicy = {
  wallet_connection: { required_band: 'adult' },
  testnet_transactions: { required_band: 'adult' },
  production_payments: { required_band: 'adult' },
  treasury_operations: { required_band: 'adult' },
  governance: { required_band: 'adult' },
};

// ---------------------------------------------------------------------------
// KYC/AML triggers per cell (WS-N.1.1a-2 sub-shape 4).  Thresholds are exact
// minor-unit integer strings — never floats.
// ---------------------------------------------------------------------------

export const KYC_VERIFICATION_LEVELS = ['none', 'kyc_partner'] as const;
export type KycVerificationLevel = (typeof KYC_VERIFICATION_LEVELS)[number];

export const kycCellSchema = z
  .object({
    verification_level: z.enum(KYC_VERIFICATION_LEVELS),
    trigger_threshold_minor_units: z
      .string()
      .regex(/^\d{1,78}$/)
      .optional(),
    trigger_asset: z.string().min(1).max(32).optional(),
  })
  .strict();
export type KycCell = z.infer<typeof kycCellSchema>;

export const kycPolicySchema = z
  .object({
    wallet_connection: kycCellSchema.optional(),
    testnet_transactions: kycCellSchema.optional(),
    production_payments: kycCellSchema.optional(),
    treasury_operations: kycCellSchema.optional(),
    governance: kycCellSchema.optional(),
  })
  .strict();
export type KycPolicy = z.infer<typeof kycPolicySchema>;

/** A structured reference to a required legal disclosure (WS-N.1.2d). */
export const disclosureRefSchema = z
  .object({
    id: z.string().min(1).max(64),
    version: z.number().int().min(1),
    /** BCP-47 locales this disclosure must cover before enablement. */
    locales: z.array(z.string().min(2).max(35)).min(1),
  })
  .strict();
export type DisclosureRef = z.infer<typeof disclosureRefSchema>;

// ---------------------------------------------------------------------------
// The entity (SPEC §22.2 field list, exactly).
// ---------------------------------------------------------------------------

export const jurisdictionFeaturePolicySchema = z
  .object({
    policy_id: uuidSchema,
    country_or_region: regionCodeSchema,
    feature_flags: featureCellStatesSchema,
    asset_flags: z.record(z.string().min(1).max(32), z.boolean()),
    age_gate_policy: ageGatePolicySchema,
    kyc_policy: kycPolicySchema,
    disclosure_refs: z.array(disclosureRefSchema),
    legal_approval_ref: z.string().min(1).max(256).nullable(),
    effective_at: isoTimestampSchema,
  })
  .strict();
export type JurisdictionFeaturePolicy = z.infer<typeof jurisdictionFeaturePolicySchema>;

export interface PolicyProblem {
  path: string;
  problem: string;
}
export type ValidatePolicyResult =
  | { ok: true; policy: JurisdictionFeaturePolicy }
  | { ok: false; problems: PolicyProblem[] };

/**
 * The WS-N.1.1a-2 `validatePolicy` helper: strict shape validation PLUS the
 * ratified cross-document invariant (mirroring `scripts/policy/validate.ts`):
 * no cell may be `enabled` unless legal approval is recorded, and asset flags
 * may only reference assets in the shared registry.  Invoked on every admin
 * write and by the row linter; a nonconforming policy is treated as ABSENT by
 * the engine (fail-closed), never partially honored.
 */
export function validatePolicy(input: unknown): ValidatePolicyResult {
  const parsed = jurisdictionFeaturePolicySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        problem: issue.message,
      })),
    };
  }
  const policy = parsed.data;
  const problems: PolicyProblem[] = [];
  if (policy.legal_approval_ref === null) {
    for (const cell of CRYPTO_FEATURE_CELLS) {
      if (policy.feature_flags[cell] === 'enabled') {
        problems.push({
          path: `feature_flags.${cell}`,
          problem: 'an enabled cell requires a recorded legal_approval_ref (fail-closed)',
        });
      }
    }
  }
  for (const asset of Object.keys(policy.asset_flags)) {
    if (!(asset in KNOMOSIS_ASSET_DECIMALS)) {
      problems.push({
        path: `asset_flags.${asset}`,
        problem: 'unknown asset id (not in the shared asset registry)',
      });
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, policy };
}

// ---------------------------------------------------------------------------
// The WS-N.1.1e counsel-gate delta (the four-eyes boundary on policy WRITES).
// ---------------------------------------------------------------------------

/** Deterministic key-sorted serialization for policy-field comparison.  The
 *  inputs are zod-parsed policy sub-shapes, so every value is JSON-safe. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(',')}}`;
}

/** The document fields, beyond the cells themselves, that govern WHAT an
 *  `enabled` cell legally means: which assets it covers, who may use it (age/
 *  KYC), what must be disclosed first, and which legal approval authorizes it.
 *  While any cell REMAINS enabled these stay under the counsel gate — without
 *  this, a delta rule keyed on cell transitions alone would let a compliance
 *  reviewer widen an approved region sideways (turn a new asset on, drop a KYC
 *  trigger or a disclosure, or rewrite the recorded approval reference). */
const COUNSEL_GOVERNED_FIELDS = [
  'asset_flags',
  'age_gate_policy',
  'kyc_policy',
  'disclosure_refs',
  'legal_approval_ref',
] as const;
export type CounselGovernedField = (typeof COUNSEL_GOVERNED_FIELDS)[number];

export interface PolicyCounselDelta {
  /** Whether the write takes the counsel capability + a fresh approval ref. */
  required: boolean;
  /** Cells transitioning non-enabled → enabled relative to the prior policy
   *  (with no prior — absent, future-dated only, or nonconforming — every
   *  enabled cell in the new document counts: nothing counsel-approved is
   *  active to inherit from). */
  newlyEnabledCells: CryptoFeatureCell[];
  /** Governed fields changed while at least one cell remains enabled. */
  changedGoverningFields: CounselGovernedField[];
}

/**
 * The WS-N.1.1e write-gate delta: counsel is required to EXPAND availability,
 * never to narrow it.  A policy write is a whole replacement document, so a
 * compliance reviewer narrowing one cell must carry the region's other,
 * already-approved `enabled` cells forward — that carry-forward is NOT an
 * enablement and must not strand a narrowing behind counsel availability.
 * Counsel is required exactly when:
 *
 *   • any cell transitions non-enabled → enabled relative to `prior` (prior
 *     `null` — missing at that instant, or nonconforming — fails closed:
 *     every enabled cell counts), OR
 *   • at least one cell REMAINS enabled and any counsel-governed field
 *     (`asset_flags`, `age_gate_policy`, `kyc_policy`, `disclosure_refs`,
 *     `legal_approval_ref`) differs from the prior policy — the enabled
 *     surface's legal terms stay counsel-controlled.
 *
 * `prior` must be the policy in force AT THE NEW DOCUMENT'S OWN
 * `effective_at` (its timeline predecessor over ALL rows, pending included),
 * not merely the policy active at write time: policies are insert-only and
 * served greatest-`effective_at`-first, so a "no-op against today" document
 * dated after a scheduled narrowing is an EXPANSION of the timeline it
 * actually lands in.  The write route additionally restricts non-counsel
 * writers to an immediate `effective_at` (between the active row and now) so
 * scheduling itself stays a counsel act.
 *
 * Comparison is order-sensitive for `disclosure_refs` (a reordering takes the
 * counsel path — strictness in the safe direction) and key-order-insensitive
 * for the record shapes.
 */
export function policyChangeRequiresCounsel(
  prior: JurisdictionFeaturePolicy | null,
  next: JurisdictionFeaturePolicy,
): PolicyCounselDelta {
  const newlyEnabledCells = CRYPTO_FEATURE_CELLS.filter(
    (cell) => next.feature_flags[cell] === 'enabled' && prior?.feature_flags[cell] !== 'enabled',
  );
  const retainsEnabledCell =
    prior !== null &&
    CRYPTO_FEATURE_CELLS.some(
      (cell) => next.feature_flags[cell] === 'enabled' && prior.feature_flags[cell] === 'enabled',
    );
  const changedGoverningFields = retainsEnabledCell
    ? COUNSEL_GOVERNED_FIELDS.filter(
        (field) => prior !== null && stableStringify(next[field]) !== stableStringify(prior[field]),
      )
    : [];
  return {
    required: newlyEnabledCells.length > 0 || changedGoverningFields.length > 0,
    newlyEnabledCells,
    changedGoverningFields,
  };
}

// ---------------------------------------------------------------------------
// Engine vocabulary (WS-N.1.1b/c): resolution bases and disable reasons.
// ---------------------------------------------------------------------------

/** How a region was resolved — strongest first (WS-N.1.1b ladder). */
export const REGION_RESOLUTION_BASES = [
  'verified_declaration',
  'locale_subtag',
  'unknown',
] as const;
export type RegionResolutionBasis = (typeof REGION_RESOLUTION_BASES)[number];
export const regionResolutionBasisSchema = z.enum(REGION_RESOLUTION_BASES);

/** Machine-readable disable reasons, 1:1 with the WS-N.1.2a UX copy. */
export const FEATURE_DISABLE_REASONS = [
  'region_unsupported',
  'policy_missing',
  'age_restricted',
  'compliance_hold',
  'policy_not_yet_effective',
  'unknown_region',
  'verification_required',
] as const;
export type FeatureDisableReason = (typeof FEATURE_DISABLE_REASONS)[number];
export const featureDisableReasonSchema = z.enum(FEATURE_DISABLE_REASONS);
