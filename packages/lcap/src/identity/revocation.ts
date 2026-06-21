// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Revocation record handling + the local revocation index (OFFLINE_SPEC §11.5,
// §15.1.1, WS-R.1.4).  Revocations are P0/C0 control records (`CONTROL_PRIORITY`)
// scheduled before all non-control content (§15.2) and consumed by trust
// projection (WS-R.8).  The index is keyed by `(revoked_kind, revoked_id)` and
// keeps the earliest-effective revocation per target; `knownEpoch` is the
// highest revocation epoch seen, used to detect a stale revocation frontier.

import { CONTROL_PRIORITY, type LcapPriority } from '../priority.js';
import type { RevocationRecordV2 } from '../schemas/records.js';

export type RevokedKind = RevocationRecordV2['revoked_kind'];

/** Revocations always schedule at P0 / lane C0 — they can never be starved. */
export function revocationPriority(): LcapPriority {
  return CONTROL_PRIORITY;
}

function key(kind: RevokedKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * An append-only index of known revocations.  Indexing is idempotent and keeps
 * the earliest-effective revocation per `(kind, id)`; a target, once revoked, is
 * revoked for good (revocation is monotone).
 */
export class RevocationIndex {
  private readonly revoked = new Map<string, RevocationRecordV2>();
  private maxEpoch = 0;

  index(revocation: RevocationRecordV2): void {
    const k = key(revocation.revoked_kind, revocation.revoked_id);
    const existing = this.revoked.get(k);
    if (!existing || revocation.revocation_epoch < existing.revocation_epoch) {
      this.revoked.set(k, revocation);
    }
    if (revocation.revocation_epoch > this.maxEpoch) this.maxEpoch = revocation.revocation_epoch;
  }

  /** The revocation record for a target, if any (carries `replacement_cid`). */
  lookup(kind: RevokedKind, id: string): RevocationRecordV2 | undefined {
    return this.revoked.get(key(kind, id));
  }

  isRevoked(kind: RevokedKind, id: string): boolean {
    return this.revoked.has(key(kind, id));
  }

  /** The highest `revocation_epoch` indexed (the local revocation frontier). */
  get knownEpoch(): number {
    return this.maxEpoch;
  }

  get size(): number {
    return this.revoked.size;
  }
}
