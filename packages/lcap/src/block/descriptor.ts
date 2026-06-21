// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Block descriptor + roles (OFFLINE_SPEC §13.1, WS-R.3.1).  Blocks are
// content-addressed by their uncompressed canonical bytes (§9.4), so a
// descriptor's `block_cid` and `sha256` are both derivable from the bytes and
// verifiable.  Role + priority drive lane assignment (WS-R.5) and attachment
// laziness (WS-R.3.3).

import { bytesEqual } from '../checkpoint/merkle.js';
import { cidFor, sha256 } from '../cid/index.js';
import type { LcapPriority } from '../priority.js';
import { type BlockDescriptorV2, blockDescriptorV2Schema } from '../schemas/records.js';

type BlockRole = BlockDescriptorV2['role'];

/** Default priority for each block role (§13.4, §15.1.1). */
export const BLOCK_ROLE_PRIORITY: Readonly<Record<BlockRole, LcapPriority>> = {
  proof_blob: 0, // trust material rides C0 with the proof closure
  body_text: 1, // core text — renders the contribution
  source_snapshot_text: 2,
  thumbnail: 2,
  encrypted_payload: 3,
  image: 3,
  video: 3,
  misc: 4,
};

export interface BuildBlockParams {
  readonly role: BlockRole;
  readonly mediaType: string;
  /** Overrides the role's default priority when set. */
  readonly priority?: LcapPriority;
}

/** Build a block descriptor over `bytes`, computing `block_cid` and `sha256`. */
export async function buildBlockDescriptor(
  bytes: Uint8Array,
  params: BuildBlockParams,
): Promise<BlockDescriptorV2> {
  return blockDescriptorV2Schema.parse({
    block_cid: await cidFor('block', bytes),
    role: params.role,
    media_type: params.mediaType,
    size_bytes: bytes.length,
    sha256: await sha256(bytes),
    priority: params.priority ?? BLOCK_ROLE_PRIORITY[params.role],
  });
}

export type BlockVerifyStatus = 'bad_block_cid' | 'bad_sha256' | 'bad_size';

export type BlockVerification = { ok: true } | { ok: false; status: BlockVerifyStatus };

/** Verify a descriptor against the block's canonical bytes. */
export async function verifyBlockDescriptor(
  descriptor: BlockDescriptorV2,
  bytes: Uint8Array,
): Promise<BlockVerification> {
  if (descriptor.size_bytes !== bytes.length) return { ok: false, status: 'bad_size' };
  if (descriptor.block_cid !== (await cidFor('block', bytes)))
    return { ok: false, status: 'bad_block_cid' };
  if (!bytesEqual(descriptor.sha256, await sha256(bytes)))
    return { ok: false, status: 'bad_sha256' };
  return { ok: true };
}
