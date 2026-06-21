// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Export disclosure (OFFLINE_SPEC §26.2, WS-R.14.2) — the PURE computation of what a
// `.licio-bundle` export reveals, so the UI can show the full §26.2 warning BEFORE
// producing a bundle.  An export is a copy that leaves the device: the recipient may
// read everything in it and MAY copy it onward.  This module derives, from the
// to-be-exported items' metadata alone, exactly which rooms are included, whether
// in-room or private (encrypted) metadata is present, whether media or identity/
// device material is included, and the approximate size — never the content itself.
// I/O-free and deterministic; the bundle-export flow (WS-R.15.1a) renders the result.

import type { LcapVisibilityScope } from '../schemas/common.js';

/** One item a prospective export would include (its disclosure-relevant metadata). */
export interface ExportItem {
  /** The home room the item belongs to (absent for account-level identity material). */
  readonly roomId?: string;
  /** The item's visibility scope (public / in_room / private). */
  readonly visibility: LcapVisibilityScope;
  /** Whether the payload is ciphertext (private-room content is encrypted). */
  readonly encrypted: boolean;
  /** The item's byte size (the approximate-size total is a §26.2 disclosure). */
  readonly sizeBytes: number;
  /** Whether the item is a media block (images/video — a §26.2 disclosure). */
  readonly isMedia: boolean;
  /** Whether the item carries identity/device material (a certificate, a device id). */
  readonly carriesIdentity: boolean;
}

/** The full §26.2 disclosure the export warning must present. */
export interface ExportDisclosure {
  /** The distinct rooms the export includes (sorted, deduplicated). */
  readonly roomIds: readonly string[];
  readonly roomCount: number;
  /** Any item is in-room (its metadata reveals room membership). */
  readonly hasInRoomMetadata: boolean;
  /** Any item is private AND encrypted (ciphertext + room-access metadata leak). */
  readonly hasPrivateEncrypted: boolean;
  /** Any media is included. */
  readonly hasMedia: boolean;
  /** Any identity/device material is included. */
  readonly carriesIdentities: boolean;
  /** The approximate total size of the export. */
  readonly approxSizeBytes: number;
  /** Always true: an export is a copy the recipient may forward (§26.2). A constant. */
  readonly recipientsMayCopyOnward: true;
}

/**
 * Compute the §26.2 export disclosure from the items a bundle would include.  The
 * "recipients may copy onward" warning is unconditional — an export is a portable
 * copy by construction — so it is always present regardless of content.
 */
export function computeExportDisclosure(items: readonly ExportItem[]): ExportDisclosure {
  const rooms = new Set<string>();
  let hasInRoomMetadata = false;
  let hasPrivateEncrypted = false;
  let hasMedia = false;
  let carriesIdentities = false;
  let approxSizeBytes = 0;

  for (const item of items) {
    if (item.roomId !== undefined) rooms.add(item.roomId);
    if (item.visibility === 'in_room') hasInRoomMetadata = true;
    if (item.visibility === 'private' && item.encrypted) hasPrivateEncrypted = true;
    if (item.isMedia) hasMedia = true;
    if (item.carriesIdentity) carriesIdentities = true;
    approxSizeBytes += item.sizeBytes;
  }

  const roomIds = [...rooms].sort();
  return {
    roomIds,
    roomCount: roomIds.length,
    hasInRoomMetadata,
    hasPrivateEncrypted,
    hasMedia,
    carriesIdentities,
    approxSizeBytes,
    recipientsMayCopyOnward: true,
  };
}
