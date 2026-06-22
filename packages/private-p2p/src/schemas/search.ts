// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.2.3 — `PrivateLocalSearchShardPlainV1` (PRIVATE_SPEC §13.7): a LOCAL-ONLY
// encrypted search index shard.  Search runs entirely on a member's device over
// decrypted content; the server has NO full-text/embedding/query path for a
// private room (§18.1).  Cross-member shard sync is never required; same-member
// cross-device sync MAY be supported but must not leak metadata.
import { z } from 'zod';
import { base64UrlSchema, privateIdSchema } from './common.js';

export const privateLocalSearchShardSchema = z
  .object({
    schema: z.literal('licio.private.local_search_shard.v1'),
    room_id: privateIdSchema,
    /** The snapshot root the shard was built against (rebuild on mismatch). */
    snapshot_root: base64UrlSchema,
    shard_id: privateIdSchema,
    index_kind: z.enum(['title', 'body', 'citation', 'attachment_alt']),
    /** The implementation-specific encrypted index payload (opaque here). */
    terms: z.unknown(),
  })
  .strict();
export type PrivateLocalSearchShard = z.infer<typeof privateLocalSearchShardSchema>;
