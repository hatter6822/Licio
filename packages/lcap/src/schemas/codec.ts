// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The record/proof codec: each schema's parse is PAIRED with LDC decode/encode
// so the wire bytes and the validated object can never diverge (WS-R.0.7).
// `decodeWithSchema` decodes canonical LDC bytes, projects the LDC value to a
// plain object, and strict-parses it; `encodeWithSchema` strict-parses an
// object and re-encodes it canonically.  Round-tripping is therefore exact:
// `encodeWithSchema(s, decodeWithSchema(s, b)) === b` for canonical `b`.

import type { z } from 'zod';
import { decode } from '../cbor/decode.js';
import { encode } from '../cbor/encode.js';
import type { LdcDecodeLimits, LdcMap, LdcValue } from '../cbor/types.js';
import { isUint8Array } from '../runtime.js';
import { roomCheckpointRecordV2Schema } from './checkpoint.js';
import { type DetachedProofV2Record, detachedProofV2Schema } from './proof.js';
import {
  type CapabilityRecordV2,
  type ContributionEventRecordV2,
  capabilityRecordV2Schema,
  contributionEventRecordV2Schema,
  type DeviceCertificateRecordV2,
  deviceCertificateRecordV2Schema,
  type RevocationRecordV2,
  revocationRecordV2Schema,
} from './records.js';

export type RecordSchemaErrorReason =
  | 'not_a_map'
  | 'forbidden_map_key'
  | 'unsupported_record_version'
  | 'unknown_record_kind'
  | 'unsupported_proof_version';

export class RecordSchemaError extends Error {
  override readonly name = 'RecordSchemaError';
  readonly reason: RecordSchemaErrorReason;
  constructor(reason: RecordSchemaErrorReason, message?: string) {
    super(message ?? `record schema error (${reason})`);
    this.reason = reason;
  }
}

/**
 * Project a decoded LDC value to a plain JS value: an LDC map (text keys only —
 * record bodies never key by integer) becomes a plain object; arrays and
 * scalars pass through; byte strings stay `Uint8Array`.
 */
export function ldcToPlain(value: LdcValue): unknown {
  if (isUint8Array(value)) return value;
  if (value instanceof Map) {
    // Null-prototype accumulator so no map key can invoke Object.prototype's
    // `__proto__` setter and mutate the prototype (pollution defense-in-depth).
    const obj: Record<string, unknown> = Object.create(null);
    for (const [key, child] of value) {
      if (typeof key !== 'string') {
        throw new RecordSchemaError('not_a_map', 'record bodies must use text map keys');
      }
      // Reject `__proto__` explicitly: zod's `.strict()` SILENTLY IGNORES it (neither
      // rejects nor preserves), so a body carrying it would parse yet lose the key on
      // re-encode — a decoder differential + broken round-trip.  No record schema has a
      // `__proto__` field, so a conformant decoder treats it as an unknown key; reject
      // it here so every implementation agrees (consensus determinism, §9.1.4).
      if (key === '__proto__') {
        throw new RecordSchemaError('forbidden_map_key', 'record map key __proto__ is not allowed');
      }
      obj[key] = ldcToPlain(child);
    }
    return obj;
  }
  if (Array.isArray(value)) return value.map((child) => ldcToPlain(child));
  return value;
}

/**
 * Project a plain JS value to an LDC value: a plain object becomes an LDC map,
 * OMITTING keys whose value is `undefined` (an absent optional is encoded by
 * omission, never as `null`, §9.1.3).  The encoder re-sorts keys, so the
 * object's property order is irrelevant.
 */
export function plainToLdc(value: unknown): LdcValue {
  if (value === null) return null;
  if (isUint8Array(value)) return value;
  if (Array.isArray(value)) return value.map((child) => plainToLdc(child));
  switch (typeof value) {
    case 'boolean':
    case 'number':
    case 'bigint':
    case 'string':
      return value;
    case 'object': {
      const map: LdcMap = new Map();
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (child === undefined) continue;
        map.set(key, plainToLdc(child));
      }
      return map;
    }
    default:
      throw new RecordSchemaError('not_a_map', `cannot encode value of type ${typeof value}`);
  }
}

/**
 * Decode canonical LDC bytes and strict-validate them through `schema`.  An optional
 * `limits` raises (or tightens) the LDC decode budget for THIS call — the pack reader
 * passes its configured `maxTableBytes`/`maxEntries` here so a table that is within the
 * advertised §27.1 cap but larger than the default 1 MiB LDC limit decodes instead of
 * being spuriously rejected as `bad_table_schema` (WS-R.14.1a).
 */
export function decodeWithSchema<T>(
  schema: z.ZodType<T>,
  bytes: Uint8Array,
  limits?: LdcDecodeLimits,
): T {
  return schema.parse(ldcToPlain(limits ? decode(bytes, limits) : decode(bytes)));
}

/** Strict-validate `value` through `schema` and re-encode it canonically. */
export function encodeWithSchema<T>(schema: z.ZodType<T>, value: T): Uint8Array {
  return encode(plainToLdc(schema.parse(value)));
}

function asPlainObject(bytes: Uint8Array): Record<string, unknown> {
  const plain = ldcToPlain(decode(bytes));
  if (typeof plain !== 'object' || plain === null || Array.isArray(plain) || isUint8Array(plain)) {
    throw new RecordSchemaError('not_a_map');
  }
  return plain as Record<string, unknown>;
}

/** The closed set of v0.2 record bodies routed by `decodeAndRouteRecord`. */
export type LcapRecordV2 =
  | DeviceCertificateRecordV2
  | CapabilityRecordV2
  | RevocationRecordV2
  | ContributionEventRecordV2;

/**
 * Decode a record body and route it to the schema for its `kind`, rejecting an
 * unsupported `record_version` or unknown `kind` (§9.1.4).  This is the single entry
 * point the trust verifier uses to turn untrusted bytes into a validated record, so it
 * routes exactly the four kinds that travel as `record_body` frames AND pass through
 * `validate()`: the contribution event and the three identity records (device
 * certificate, room capability, revocation).
 *
 * The other v0.2 record kinds — room checkpoints, inclusion/consistency proofs, witness
 * statements, receipts, bundle manifests, fork evidence — are NOT routed here BY DESIGN:
 * they are control material that never arrives as a `record_body` frame and does not go
 * through `validate()`'s contribution/identity trust projection (which would be
 * meaningless for them).  Each travels its own channel with its own encode + verify —
 * checkpoints / inclusion / consistency over the §29.7 GET routes, receipts in the
 * exchange `receipts`/`ack_receipts` fields, the manifest in the pack header, fork
 * evidence gossiped — so reaching this `default` with one of those kinds means it was
 * wrongly placed in a record frame, which is correctly `rejected_bad_schema`.
 */
export function decodeAndRouteRecord(bytes: Uint8Array): LcapRecordV2 {
  const plain = asPlainObject(bytes);
  if (plain['record_version'] !== 2) throw new RecordSchemaError('unsupported_record_version');
  switch (plain['kind']) {
    case 'device_certificate':
      return deviceCertificateRecordV2Schema.parse(plain);
    case 'room_capability':
      return capabilityRecordV2Schema.parse(plain);
    case 'revocation':
      return revocationRecordV2Schema.parse(plain);
    case 'contribution_event':
      return contributionEventRecordV2Schema.parse(plain);
    default:
      throw new RecordSchemaError('unknown_record_kind');
  }
}

/** Decode and strict-validate a detached proof body (rejecting non-v2). */
export function decodeProof(bytes: Uint8Array): DetachedProofV2Record {
  const plain = asPlainObject(bytes);
  if (plain['proof_version'] !== 2) throw new RecordSchemaError('unsupported_proof_version');
  return detachedProofV2Schema.parse(plain);
}

/**
 * Whether `bytes` are a well-formed PUBLIC control record — currently the room checkpoint, the one
 * control record a node advertises (§17.2 `latest_checkpoint_cid`) and serves over the public §29
 * surface.  `decodeAndRouteRecord` rejects control records BY DESIGN (a checkpoint never travels as
 * a `record_body` frame through `validate()`'s contribution/identity trust projection), so a
 * public-serve gate that classifies a record's visibility cannot rely on it for checkpoints — it
 * uses THIS predicate instead.  A checkpoint carries no `visibility_scope`: it is public
 * transparency material (a Merkle-tree head a peer fetches by its advertised CID), so a well-formed
 * one is public-servable.  Returns false for any non-checkpoint / malformed body (fail-closed).
 */
export function isPublicControlRecord(bytes: Uint8Array): boolean {
  let plain: Record<string, unknown>;
  try {
    plain = asPlainObject(bytes);
  } catch {
    return false;
  }
  if (plain['kind'] !== 'room_checkpoint') return false;
  return roomCheckpointRecordV2Schema.safeParse(plain).success;
}
