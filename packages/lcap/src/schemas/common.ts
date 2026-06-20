// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared schema primitives for the §4.1 type aliases.  LDC carries only
// integers (no floats, §9.1.2), so every numeric field is `z.number().int()`;
// binary fields are `Uint8Array`; CID fields are validated as well-formed CIDs
// of the expected kind via the structural `parseCid` (§9.2).

import { z } from 'zod';
import { type CidKind, parseCid } from '../cid/index.js';

/**
 * A CBOR byte string (public keys, signatures, hashes, nonces; §9.1.2).  Uses
 * `z.custom` rather than `z.instanceof` so the inferred type is the general
 * `Uint8Array` (any backing buffer), matching what the codec / WebCrypto produce
 * — `z.instanceof(Uint8Array)` would narrow to `Uint8Array<ArrayBuffer>` (TS 5.7+).
 */
export const bytesSchema = z.custom<Uint8Array>((value) => value instanceof Uint8Array, {
  message: 'expected a Uint8Array',
});

/** A non-negative integer quantity (counts, sizes, epochs). */
export const uintSchema = z.number().int().nonnegative();

/** Unix epoch milliseconds (integer; §9.1.2 — time is integer ms). */
export const epochMsSchema = z.number().int();

/** A scheduling priority `0..4` (lower = sooner; §15.1.1). */
export const prioritySchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);

/** Per-item visibility scope (§11.3, §12.1). */
export const visibilityScopeSchema = z.enum(['public', 'in_room', 'private']);
export type LcapVisibilityScope = z.infer<typeof visibilityScopeSchema>;

/** Every deterministic record body's `kind` (§4.1). */
export const lcapRecordKindSchema = z.enum([
  'contribution_event',
  'device_certificate',
  'room_capability',
  'revocation',
  'bundle_manifest',
  'room_checkpoint',
  'inclusion_proof',
  'consistency_proof',
  'witness_statement',
  'receipt',
  'fork_evidence',
  'availability_advertisement',
  'policy_object',
]);

/** Operations a room capability may authorize (§4.1). */
export const lcapOperationSchema = z.enum([
  'post',
  'reply',
  'edit',
  'tombstone',
  'moderate',
  'source_snapshot',
  'summary',
  'invite',
]);
export type LcapOperation = z.infer<typeof lcapOperationSchema>;

/** Compression negotiation identifiers (§4.1). */
export const compressionIdSchema = z.enum(['none', 'gzip', 'deflate', 'zstd']);

/** A string that parses as a well-formed CID of any kind (§9.2). */
export const anyCidSchema = z.string().refine(
  (value) => {
    try {
      parseCid(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'expected a well-formed LCAP CID' },
);

/** A string that parses as a well-formed CID of exactly `kind`. */
export function cidSchemaOf(kind: CidKind): z.ZodType<string> {
  return z.string().refine(
    (value) => {
      try {
        return parseCid(value).kind === kind;
      } catch {
        return false;
      }
    },
    { message: `expected a ${kind} CID` },
  );
}

export const recordCidSchema = cidSchemaOf('record');
export const blockCidSchema = cidSchemaOf('block');
export const chunkCidSchema = cidSchemaOf('chunk');
