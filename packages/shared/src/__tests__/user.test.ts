// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  defaultPersonalizationSettings,
  defaultPrivacySettings,
} from '../schemas/privacy-settings.js';
import {
  type AgeBand,
  deriveAgeBand,
  emptyReputationSummary,
  HANDLE_PATTERN,
  handleSchema,
  isMinorBand,
  USER_ACCOUNT_STATES,
  userAccountStateSchema,
  userCreateSchema,
  userPublicSchema,
  userRecordSchema,
  userUpdateSchema,
} from '../schemas/user.js';

describe('deriveAgeBand boundaries', () => {
  // A fixed reference instant keeps the boundary tests deterministic.
  const REF = new Date('2026-06-09T12:00:00.000Z');

  /** DOB string for someone who is exactly `years` old today (birthday is today). */
  function dobForAge(years: number): string {
    const d = new Date(Date.UTC(REF.getUTCFullYear() - years, REF.getUTCMonth(), REF.getUTCDate()));
    return d.toISOString().slice(0, 10);
  }

  it.each([
    [12, 'under_13'],
    [11, 'under_13'],
    [0, 'under_13'],
  ])('age %i is blocked (under_13)', (age) => {
    const r = deriveAgeBand(dobForAge(age), REF);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe('under_13');
  });

  it.each<[number, AgeBand]>([
    [13, 'teen_13_15'],
    [14, 'teen_13_15'],
    [15, 'teen_13_15'],
    [16, 'teen_16_17'],
    [17, 'teen_16_17'],
    [18, 'adult'],
    [40, 'adult'],
  ])('age %i maps to band %s', (age, band) => {
    const r = deriveAgeBand(dobForAge(age), REF);
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.band).toBe(band);
  });

  it('treats the day BEFORE the 13th birthday as under_13 (not yet 13)', () => {
    // Born 13 years ago but tomorrow relative to REF ⇒ still 12 today.
    const dob = new Date(
      Date.UTC(REF.getUTCFullYear() - 13, REF.getUTCMonth(), REF.getUTCDate() + 1),
    );
    const r = deriveAgeBand(dob.toISOString().slice(0, 10), REF);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe('under_13');
  });

  it('treats the exact 18th birthday as adult', () => {
    const r = deriveAgeBand(dobForAge(18), REF);
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.band).toBe('adult');
  });

  it('handles a Feb-29 leap-day birthday', () => {
    // Born 2008-02-29; on 2026-06-09 they are 18.
    const r = deriveAgeBand('2008-02-29', REF);
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.band).toBe('adult');
  });

  it('rejects a future date of birth', () => {
    const r = deriveAgeBand('2030-01-01', REF);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe('invalid_date');
  });

  it('rejects a structurally invalid date string', () => {
    for (const bad of ['not-a-date', '2021-13-01', '2021-02-30', '20210101', '2021-1-1']) {
      const r = deriveAgeBand(bad, REF);
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.reason).toBe('invalid_date');
    }
  });

  it('rejects an absurdly old date (likely typo)', () => {
    const r = deriveAgeBand('1850-01-01', REF);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe('invalid_date');
  });

  it('accepts a Date object as well as a string', () => {
    const r = deriveAgeBand(new Date(Date.UTC(2000, 0, 1)), REF);
    expect(r.allowed).toBe(true);
  });

  it('rejects an invalid Date object', () => {
    const r = deriveAgeBand(new Date('invalid'), REF);
    expect(r.allowed).toBe(false);
  });

  it('uses the current time when no reference is supplied (smoke)', () => {
    // Someone born in 1990 is unambiguously an adult regardless of "today".
    const r = deriveAgeBand('1990-01-01');
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.band).toBe('adult');
  });
});

describe('isMinorBand', () => {
  it('classifies teen bands as minors and adult/null as not', () => {
    expect(isMinorBand('teen_13_15')).toBe(true);
    expect(isMinorBand('teen_16_17')).toBe(true);
    expect(isMinorBand('adult')).toBe(false);
    expect(isMinorBand(null)).toBe(false);
  });
});

describe('handle validation', () => {
  it('accepts valid handles and rejects invalid ones', () => {
    for (const ok of ['abc', 'User_123', 'a'.repeat(30)]) {
      expect(HANDLE_PATTERN.test(ok)).toBe(true);
      expect(() => handleSchema.parse(ok)).not.toThrow();
    }
    for (const bad of ['ab', 'a'.repeat(31), 'has space', 'dot.dot', 'emoji😀', '']) {
      expect(() => handleSchema.parse(bad)).toThrow();
    }
  });
});

describe('userCreateSchema', () => {
  it('parses a valid passkey-only registration (no email, no password)', () => {
    const parsed = userCreateSchema.parse({
      handle: 'newuser',
      display_name: 'New User',
      age_band: 'adult',
      primary_credential: 'webauthn',
    });
    expect(parsed.email).toBeUndefined();
  });

  it('has NO password field anywhere in its shape (structural)', () => {
    const shapeKeys = Object.keys(userCreateSchema.shape);
    expect(shapeKeys).not.toContain('password');
    expect(shapeKeys.some((k) => /pass(word|phrase|code)/i.test(k))).toBe(false);
  });

  it('rejects an unknown key (e.g. a smuggled password)', () => {
    expect(() =>
      userCreateSchema.parse({
        handle: 'newuser',
        display_name: 'New User',
        age_band: 'adult',
        primary_credential: 'webauthn',
        password: 'hunter2',
      }),
    ).toThrow();
  });

  it('requires a primary credential method', () => {
    expect(() =>
      userCreateSchema.parse({ handle: 'newuser', display_name: 'New User', age_band: 'adult' }),
    ).toThrow();
  });

  it('validates email format when an email is supplied', () => {
    expect(() =>
      userCreateSchema.parse({
        handle: 'newuser',
        display_name: 'New User',
        email: 'not-an-email',
        age_band: 'adult',
        primary_credential: 'email_otp',
      }),
    ).toThrow();
  });
});

describe('userUpdateSchema', () => {
  it('accepts a partial update', () => {
    expect(() => userUpdateSchema.parse({ display_name: 'Renamed' })).not.toThrow();
    expect(() => userUpdateSchema.parse({})).not.toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() => userUpdateSchema.parse({ account_state: 'deleted' })).toThrow();
  });
});

describe('account_state domain (WS-J restricted)', () => {
  it('includes the restricted sanction and parses it', () => {
    expect(USER_ACCOUNT_STATES).toContain('restricted');
    expect(userAccountStateSchema.parse('restricted')).toBe('restricted');
    // The full DB domain (superset of the client schema, which omits `deleted`).
    expect([...USER_ACCOUNT_STATES]).toEqual([
      'active',
      'suspended',
      'restricted',
      'deactivated',
      'deleted',
    ]);
  });
});

describe('userPublicSchema leak guard', () => {
  const fullRecord = {
    user_id: '11111111-1111-4111-8111-111111111111',
    handle: 'someone',
    display_name: 'Some One',
    email: 'private@example.com',
    account_state: 'active' as const,
    locale: 'en-US',
    age_band_if_known: 'adult' as const,
    privacy_settings: defaultPrivacySettings(),
    personalization_settings: defaultPersonalizationSettings(),
    reputation_summary_private: emptyReputationSummary(),
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  };

  it('is a valid full record to begin with', () => {
    expect(() => userRecordSchema.parse(fullRecord)).not.toThrow();
  });

  it('strips every private field when parsing a full record', () => {
    const pub = userPublicSchema.parse(fullRecord) as Record<string, unknown>;
    for (const secret of [
      'email',
      'privacy_settings',
      'personalization_settings',
      'reputation_summary_private',
      'age_band_if_known',
      'updated_at',
    ]) {
      expect(secret in pub).toBe(false);
    }
    // Public fields survive.
    expect(pub['handle']).toBe('someone');
    expect(pub['user_id']).toBe(fullRecord.user_id);
  });
});
