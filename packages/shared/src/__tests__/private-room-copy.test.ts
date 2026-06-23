// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.0.2/0.3 — the mandatory honest-limits copy + Appendix E privacy matrix
// SSOT (PRIVATE_SPEC §6, §20.2, §20.5, Appendix E).  The copy-lint: the wording
// is exact, all five acknowledgments are present, "private" is qualified for
// server rooms (§20.1), and no string makes a false absolute promise
// ("secure", "deleted everywhere", "fully private", "guaranteed").
import { describe, expect, it } from 'vitest';
import {
  PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS,
  PRIVATE_ROOM_CREATION_DISCLOSURE,
  PRIVATE_ROOM_IMPORT_MODES,
  PRIVATE_ROOM_MIGRATION_PHASES,
  PRIVATE_ROOM_MIGRATION_WARNING,
  PRIVATE_ROOM_PRIVACY_MATRIX,
  PRIVATE_ROOM_REMOVAL_DISCLOSURE,
  REQUIRED_PRIVATE_ROOM_ACKNOWLEDGMENT_IDS,
  ROOM_CLASS_UI_LABELS,
} from '../constants/private-rooms.js';

describe('WS-S.0.3 mandatory disclosure copy', () => {
  it('the creation disclosure states every §6 honest limit', () => {
    const text = PRIVATE_ROOM_CREATION_DISCLOSURE;
    expect(text).toContain('Licio does not host');
    expect(text).toContain('cannot read, moderate, recover, or add members');
    expect(text).toContain('Removed members may keep content');
    expect(text).toContain('Members can still copy');
    expect(text).toContain('recovery kit');
  });

  it('the removal disclosure is non-retroactive (future reading only)', () => {
    expect(PRIVATE_ROOM_REMOVAL_DISCLOSURE).toContain('future room updates');
    expect(PRIVATE_ROOM_REMOVAL_DISCLOSURE).toContain('cannot delete or recall');
  });

  it('has exactly the five §20.2 acknowledgments with stable ids', () => {
    expect(PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS).toHaveLength(5);
    expect(REQUIRED_PRIVATE_ROOM_ACKNOWLEDGMENT_IDS).toEqual([
      'cannot_recover',
      'keys_lost_permanent',
      'members_can_copy',
      'removal_not_deletion',
      'availability_device_dependent',
    ]);
    expect(PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS.map((a) => a.label)).toContain(
      'Members can copy or disclose content.',
    );
  });
});

describe('WS-S.0.2 privacy matrix (Appendix E)', () => {
  it('covers the eight Appendix E questions across the three classes', () => {
    expect(PRIVATE_ROOM_PRIVACY_MATRIX).toHaveLength(8);
    const hosting = PRIVATE_ROOM_PRIVACY_MATRIX.find((r) =>
      r.question.startsWith('Can Licio host'),
    );
    expect(hosting?.private_p2p).toBe('No');
    expect(hosting?.public_server).toBe('Yes');
    const gateways = PRIVATE_ROOM_PRIVACY_MATRIX.find((r) => r.question.includes('IPFS gateways'));
    expect(gateways?.private_p2p).toBe('Forbidden');
  });

  it('the matrix is honest: P2P never claims recovery or admin access', () => {
    const recover = PRIVATE_ROOM_PRIVACY_MATRIX.find((r) => r.question.includes('recover'));
    expect(recover?.private_p2p).toBe('No');
    const access = PRIVATE_ROOM_PRIVACY_MATRIX.find((r) => r.question.includes('admins'));
    expect(access?.private_p2p).toBe('No');
  });
});

describe('WS-S.0.2 naming discipline (§20.1)', () => {
  it('a server restricted room is "Members-only server room", never simply "private"', () => {
    expect(ROOM_CLASS_UI_LABELS.restricted_server).toBe('Members-only server room');
    expect(ROOM_CLASS_UI_LABELS.restricted_server.toLowerCase()).not.toMatch(/(^|\s)private(\s|$)/);
    expect(ROOM_CLASS_UI_LABELS.private_p2p).toContain('Private');
  });
});

describe('WS-S.0.3 prohibited-language copy-lint (no false absolute promise)', () => {
  // The honest-non-goals doctrine (§6): the copy must NEVER promise the
  // impossible.  No disclosure/label/matrix-answer may use an unqualified
  // absolute that overstates the guarantee.
  const FORBIDDEN = [
    /\bsecure\b/i,
    /deleted everywhere/i,
    /fully private/i,
    /completely private/i,
    /\bguaranteed\b/i,
    /\buntraceable\b/i,
    /\banonymous\b/i,
  ];
  const allCopy = [
    PRIVATE_ROOM_CREATION_DISCLOSURE,
    PRIVATE_ROOM_REMOVAL_DISCLOSURE,
    PRIVATE_ROOM_MIGRATION_WARNING,
    ...PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS.map((a) => a.label),
    ...PRIVATE_ROOM_IMPORT_MODES.flatMap((m) => [m.label, m.description, m.disclosure]),
    ...PRIVATE_ROOM_MIGRATION_PHASES.flatMap((p) => [p.label, p.detail]),
    ...PRIVATE_ROOM_PRIVACY_MATRIX.flatMap((r) => [
      r.question,
      r.public_server,
      r.restricted_server,
      r.private_p2p,
    ]),
    ...Object.values(ROOM_CLASS_UI_LABELS),
  ];

  it('no copy string makes a false absolute privacy promise', () => {
    for (const text of allCopy) {
      for (const forbidden of FORBIDDEN) {
        expect(forbidden.test(text), `forbidden phrasing in: "${text}"`).toBe(false);
      }
    }
  });
});

describe('WS-S.9 migration copy (PRIVATE_SPEC §24)', () => {
  it('the §24.3 warning is non-retroactive (cannot undo past server access)', () => {
    expect(PRIVATE_ROOM_MIGRATION_WARNING).toContain('from this point forward');
    expect(PRIVATE_ROOM_MIGRATION_WARNING).toContain('cannot make past server access impossible');
    expect(PRIVATE_ROOM_MIGRATION_WARNING).toContain('start fresh');
  });

  it('has the four §24.2 import modes, each with an honest leakage disclosure', () => {
    expect(PRIVATE_ROOM_IMPORT_MODES.map((m) => m.id)).toEqual([
      'fresh',
      'selected',
      'full',
      'redacted',
    ]);
    // Every NON-fresh mode must disclose that imported history was server-hosted.
    for (const mode of PRIVATE_ROOM_IMPORT_MODES) {
      if (mode.id === 'fresh') continue;
      expect(mode.disclosure.toLowerCase()).toContain('server');
    }
  });

  it('has the six §24.2 migration phases in order (new room, never in-place)', () => {
    expect(PRIVATE_ROOM_MIGRATION_PHASES.map((p) => p.id)).toEqual([
      'rename_disclose',
      'create_destination',
      'choose_import',
      'reinvite_members',
      'freeze_old',
      'purge_minimize',
    ]);
  });
});
