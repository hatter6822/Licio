// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Export disclosure (§26.2) + stealth mode (§26.3, WS-R.14.2): the §26.2 warning is
// computed completely from item metadata (rooms, in-room/private-encrypted, media,
// identities, size) with an unconditional "recipients may copy onward"; stealth
// disables every AUTOMATIC reveal channel while never blocking a user-initiated
// action, and names exports generically.

import { describe, expect, it } from 'vitest';
import {
  computeExportDisclosure,
  type ExportItem,
  genericExportFilename,
  STEALTH_OFF,
  STEALTH_ON,
  stealthAllows,
  stealthPolicy,
} from '../privacy/index.js';

const item = (over: Partial<ExportItem> = {}): ExportItem => ({
  roomId: 'room-1',
  visibility: 'public',
  encrypted: false,
  sizeBytes: 100,
  isMedia: false,
  carriesIdentity: false,
  ...over,
});

describe('computeExportDisclosure (§26.2)', () => {
  it('summarizes an empty export with the unconditional copy-onward warning', () => {
    const d = computeExportDisclosure([]);
    expect(d).toEqual({
      roomIds: [],
      roomCount: 0,
      hasInRoomMetadata: false,
      hasPrivateEncrypted: false,
      hasMedia: false,
      carriesIdentities: false,
      approxSizeBytes: 0,
      recipientsMayCopyOnward: true,
    });
  });

  it('lists distinct rooms sorted and sums the approximate size', () => {
    const d = computeExportDisclosure([
      item({ roomId: 'b', sizeBytes: 10 }),
      item({ roomId: 'a', sizeBytes: 20 }),
      item({ roomId: 'b', sizeBytes: 5 }),
      // Identity material — no room (omit roomId under exactOptionalPropertyTypes).
      {
        visibility: 'public',
        encrypted: false,
        sizeBytes: 1,
        isMedia: false,
        carriesIdentity: true,
      },
    ]);
    expect(d.roomIds).toEqual(['a', 'b']);
    expect(d.roomCount).toBe(2);
    expect(d.approxSizeBytes).toBe(36);
  });

  it('flags in-room metadata, private-encrypted, media, and identity material', () => {
    const d = computeExportDisclosure([
      item({ visibility: 'in_room' }),
      item({ visibility: 'private', encrypted: true }),
      item({ isMedia: true }),
      item({ carriesIdentity: true }),
    ]);
    expect(d.hasInRoomMetadata).toBe(true);
    expect(d.hasPrivateEncrypted).toBe(true);
    expect(d.hasMedia).toBe(true);
    expect(d.carriesIdentities).toBe(true);
  });

  it('does NOT flag private-encrypted for plaintext private (it should never export)', () => {
    const d = computeExportDisclosure([item({ visibility: 'private', encrypted: false })]);
    expect(d.hasPrivateEncrypted).toBe(false);
  });
});

describe('stealth mode (§26.3)', () => {
  it('disables every automatic-reveal channel when ON, keeps them when OFF', () => {
    expect(STEALTH_ON.localDiscovery).toBe(false);
    expect(STEALTH_ON.courierAdvertising).toBe(false);
    expect(STEALTH_ON.backgroundRelaySync).toBe(false);
    expect(STEALTH_ON.genericFilenames).toBe(true);
    expect(STEALTH_ON.c0OnlyUnlessUserInitiated).toBe(true);
    expect(STEALTH_ON.confirmBeforeExport).toBe(true);
    expect(STEALTH_OFF.localDiscovery).toBe(true);
    expect(stealthPolicy(true)).toBe(STEALTH_ON);
    expect(stealthPolicy(false)).toBe(STEALTH_OFF);
  });

  it('blocks automatic channels under stealth but ALWAYS allows a user-initiated action', () => {
    expect(stealthAllows(STEALTH_ON, 'local_discovery')).toBe(false);
    expect(stealthAllows(STEALTH_ON, 'courier_advertise')).toBe(false);
    expect(stealthAllows(STEALTH_ON, 'background_sync')).toBe(false);
    expect(stealthAllows(STEALTH_ON, 'user_initiated')).toBe(true);
    // Without stealth, the automatic channels are permitted.
    expect(stealthAllows(STEALTH_OFF, 'background_sync')).toBe(true);
  });

  it('names exports generically at whole-day granularity (no room/topic/precise time)', () => {
    const name = genericExportFilename(Date.UTC(2026, 5, 21, 13, 45));
    expect(name).toMatch(/^licio-bundle-\d+\.licio-bundle$/);
    // Two exports the same day collide-free-ness is day-stamped, not time-stamped.
    expect(genericExportFilename(Date.UTC(2026, 5, 21, 1))).toBe(
      genericExportFilename(Date.UTC(2026, 5, 21, 23)),
    );
    expect(genericExportFilename(Date.UTC(2026, 5, 22, 1))).not.toBe(name);
  });
});
