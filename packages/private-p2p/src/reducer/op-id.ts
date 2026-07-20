// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.3b — the §14.3.2 op-id derivation.  PRIVATE_SPEC §14.3.2 requires the
// canonical-order tiebreakers (incl. `op_id`) to be "fully determined by op
// content" so every device derives the identical sequence.  An author-CHOSEN
// free-string op_id violates that: a member could mint an envelope whose op_id
// equals ANOTHER member's op and — because the engine's device-fork resolution
// keeps the bytewise-smaller signature regardless of author — displace the
// victim's op everywhere (op-id squatting).  Binding op_id to `(author_device_id,
// author_seq)` closes it structurally:
//
//   * two ops from DIFFERENT devices can never collide (distinct device id), so a
//     cross-author op_id collision is impossible — `openOp` rejects any envelope
//     whose `op_id !== deriveOpId(author_device_id, author_seq)` before it can
//     reach the fork resolver;
//   * two ops from ONE device collide only at the same `author_seq`, which the
//     §14.2 monotonic-seq rule already rejects — so a genuine same-op_id pair is
//     only an idempotent re-seal of the identical op (correctly absorbed).
//
// The id is a domain-separated SHA-256 over the canonical CBOR of the tuple, so it
// is charset-safe (no delimiter injection between the device id and the seq) and
// deterministic across devices.

import { canonical } from '../crypto/canonical.js';
import { sha256, toBase64Url } from '../crypto/runtime.js';

const OP_ID_DOMAIN = 'licio.private.op-id.v1';

/**
 * The §14.3.2 op id for an op authored by `authorDeviceId` at `authorSeq`.
 * Deterministic and non-forgeable across authors: `openOp` binds it, and every
 * op-authoring path (`buildRoomOp`, the genesis, the snapshot commit) mints it
 * from these two authenticated fields rather than a free/random string.
 */
export async function deriveOpId(authorDeviceId: string, authorSeq: number): Promise<string> {
  const bytes = canonical([OP_ID_DOMAIN, authorDeviceId, authorSeq]);
  return toBase64Url(await sha256(bytes));
}
