// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical User entity (SPEC §22.1) plus the registration/profile zod schemas
// (WS-D.1.1a/b/d) and the age-gate derivation (WS-D.1.7a).
//
// WebAuthn-first, passwordless ALWAYS: there is no password field anywhere in
// this surface (WS-D overview).  `userCreateSchema` names exactly one primary
// credential method and carries no shared secret.  A structural test asserts no
// key named `password` exists on any User schema, so a password login path can
// never be built against these types.
//
// `userPublicSchema` is built by `.pick()`-ing an ALLOWLIST of fields off the
// full record (fail-closed: a newly added private field is excluded by default,
// WS-D.1.1d), never by `.omit()`-ing a denylist.
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import { personalizationSettingsSchema, privacySettingsSchema } from './privacy-settings.js';

// ---------------------------------------------------------------------------
// Enumerations (the §22.1 column domains).
// ---------------------------------------------------------------------------

/**
 * Account lifecycle (§22.1 account_state).  Distinct from the WS-C client-facing
 * `accountStateSchema` in `profile.ts`: this is the canonical DB domain, which
 * includes `deleted` (a tombstone state) and omits the client's `restricted`.
 * The enum deliberately has no `pending`/`unverified` value — verification lives
 * in a separate column (WS-D.1.4a), so an unverified account is still `active`
 * with reduced capabilities (WS-D.1.1a Security/Privacy note).
 */
export const USER_ACCOUNT_STATES = ['active', 'suspended', 'deactivated', 'deleted'] as const;
export type UserAccountState = (typeof USER_ACCOUNT_STATES)[number];
export const userAccountStateSchema = z.enum(USER_ACCOUNT_STATES);

/** Coarse age band — the ONLY age attribute ever persisted (§19.4 minimization). */
export const AGE_BANDS = ['adult', 'teen_16_17', 'teen_13_15'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];
export const ageBandSchema = z.enum(AGE_BANDS);

/** Handle policy: ASCII alphanumeric + underscore, 3–30 chars (matches the DB CHECK). */
export const HANDLE_PATTERN = /^[A-Za-z0-9_]{3,30}$/;
export const handleSchema = z
  .string()
  .regex(HANDLE_PATTERN, { message: 'handle must be 3–30 chars: letters, digits, underscore' });

/** Email — optional everywhere (passkey/wallet-only accounts carry none, §19.1). */
export const emailSchema = z.string().email().max(254);

/** BCP-47 language tag (loose bounds; full validation is a WS-i18n concern). */
export const localeSchema = z.string().min(2).max(35);

// ---------------------------------------------------------------------------
// Reputation summary (WS-D.1.1b) — private to the user, never in any public
// response.  Each domain score is a probability in [0,1] or null (uncomputed).
// ---------------------------------------------------------------------------
export const reputationSummaryPrivateSchema = z
  .object({
    schema_version: z.literal(1),
    evidence_reliability: z.number().min(0).max(1).nullable(),
    correction_accuracy: z.number().min(0).max(1).nullable(),
    bridge_ability: z.number().min(0).max(1).nullable(),
    computed_at: isoTimestampSchema.nullable(),
  })
  .strict();
export type ReputationSummaryPrivate = z.infer<typeof reputationSummaryPrivateSchema>;

/** A fresh, never-computed reputation summary (all scores null). */
export function emptyReputationSummary(): ReputationSummaryPrivate {
  return {
    schema_version: 1,
    evidence_reliability: null,
    correction_accuracy: null,
    bridge_ability: null,
    computed_at: null,
  };
}

// ---------------------------------------------------------------------------
// Age-gate derivation (WS-D.1.7a).  The raw date of birth is used transiently
// to compute a band and then discarded — it is NEVER stored (§19.4).  Under-13
// is a hard BLOCK: no User row is created.  The function is total: every input,
// including malformed or future dates, maps to a defined result.
// ---------------------------------------------------------------------------

export type AgeGateResult =
  | { allowed: true; band: AgeBand }
  | { allowed: false; reason: 'under_13' | 'invalid_date' };

/** Minimum age (years) for any account at all (§19.4 "not directed to children under 13"). */
export const MINIMUM_AGE_YEARS = 13;

/**
 * Completed whole years between `dob` and `reference`, using the standard
 * birthday rule: a person born on Feb-29 or any date "turns N" only once the
 * month/day has been reached in the reference year.  Returns a non-negative
 * integer for any `dob <= reference`.
 */
function completedYears(dob: Date, reference: Date): number {
  let age = reference.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = reference.getUTCMonth() - dob.getUTCMonth();
  const dayDelta = reference.getUTCDate() - dob.getUTCDate();
  if (monthDelta < 0 || (monthDelta === 0 && dayDelta < 0)) {
    age -= 1;
  }
  return age;
}

/**
 * Derive the age band from a date of birth.  Accepts a `Date` or a `YYYY-MM-DD`
 * string.  A future, non-finite, or unparseable date yields `invalid_date`; an
 * age under 13 yields `under_13` (the registration BLOCK); otherwise the band.
 *
 * Banding (completed years):
 *   13–15 → teen_13_15, 16–17 → teen_16_17, 18+ → adult.
 */
export function deriveAgeBand(dob: Date | string, reference: Date = new Date()): AgeGateResult {
  const birth = typeof dob === 'string' ? parseBirthDate(dob) : dob;
  if (birth === null || Number.isNaN(birth.getTime())) {
    return { allowed: false, reason: 'invalid_date' };
  }
  if (Number.isNaN(reference.getTime()) || birth.getTime() > reference.getTime()) {
    return { allowed: false, reason: 'invalid_date' };
  }
  const age = completedYears(birth, reference);
  // A 150+ age almost certainly indicates a typo/garbage input; reject rather
  // than silently classify as adult.
  if (age > 150) {
    return { allowed: false, reason: 'invalid_date' };
  }
  if (age < MINIMUM_AGE_YEARS) {
    return { allowed: false, reason: 'under_13' };
  }
  if (age <= 15) return { allowed: true, band: 'teen_13_15' };
  if (age <= 17) return { allowed: true, band: 'teen_16_17' };
  return { allowed: true, band: 'adult' };
}

/** Whether an age band denotes a minor (any teen band). */
export function isMinorBand(band: AgeBand | null): boolean {
  return band === 'teen_13_15' || band === 'teen_16_17';
}

/**
 * Parse a strict `YYYY-MM-DD` date as UTC midnight, rejecting values that the
 * `Date` constructor would silently roll over (e.g. `2021-02-30`).  Returns null
 * on any structural or range violation.
 */
function parseBirthDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Reject rollover: if any component changed, the calendar date was invalid.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

// ---------------------------------------------------------------------------
// Registration / profile schemas (WS-D.1.1d).
// ---------------------------------------------------------------------------

/** Primary credential methods (no password — WebAuthn-first, passwordless). */
export const PRIMARY_CREDENTIAL_METHODS = ['webauthn', 'email_otp', 'wallet'] as const;
export type PrimaryCredentialMethod = (typeof PRIMARY_CREDENTIAL_METHODS)[number];
export const primaryCredentialMethodSchema = z.enum(PRIMARY_CREDENTIAL_METHODS);

/**
 * Fields needed to create an account.  Email is OPTIONAL; `primary_credential`
 * names exactly one method (the proof itself is carried by the method-specific
 * registration route).  There is NO password field, by construction.
 */
export const userCreateSchema = z
  .object({
    handle: handleSchema,
    display_name: z.string().min(1).max(80),
    email: emailSchema.optional(),
    age_band: ageBandSchema,
    primary_credential: primaryCredentialMethodSchema,
  })
  .strict();
export type UserCreate = z.infer<typeof userCreateSchema>;

/** Partial profile update (self-service).  Privacy/personalization included. */
export const userUpdateSchema = z
  .object({
    display_name: z.string().min(1).max(80),
    locale: localeSchema,
    privacy_settings: privacySettingsSchema,
    personalization_settings: personalizationSettingsSchema,
  })
  .partial()
  .strict();
export type UserUpdate = z.infer<typeof userUpdateSchema>;

/** The full persisted User row (§22.1), the source for the public/private views. */
export const userRecordSchema = z
  .object({
    user_id: uuidSchema,
    handle: handleSchema,
    display_name: z.string().min(1).max(80),
    email: emailSchema.nullable(),
    account_state: userAccountStateSchema,
    locale: localeSchema.nullable(),
    age_band_if_known: ageBandSchema.nullable(),
    privacy_settings: privacySettingsSchema,
    personalization_settings: personalizationSettingsSchema,
    reputation_summary_private: reputationSummaryPrivateSchema,
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict();
export type UserRecord = z.infer<typeof userRecordSchema>;

/**
 * Fields safe to expose to OTHER users.  Built by allowlisting via `.pick()` so a
 * future private field is excluded by default (fail-closed leak prevention).
 * Explicitly excludes email, privacy_settings, personalization_settings, and
 * reputation_summary_private.
 */
export const userPublicSchema = userRecordSchema
  .pick({
    user_id: true,
    handle: true,
    display_name: true,
    locale: true,
    account_state: true,
    created_at: true,
  })
  // `.pick()` inherits the record's `.strict()`; `.strip()` makes parsing a full
  // record DROP the unlisted private fields instead of throwing — the leak guard.
  .strip();
export type UserPublic = z.infer<typeof userPublicSchema>;

/** The authenticated user's own full record (all private fields included). */
export const userPrivateSchema = userRecordSchema;
export type UserPrivate = z.infer<typeof userPrivateSchema>;
