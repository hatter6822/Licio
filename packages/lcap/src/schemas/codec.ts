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
import type { LdcMap, LdcValue } from '../cbor/types.js';
import { isUint8Array } from '../runtime.js';
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
    const obj: Record<string, unknown> = {};
    for (const [key, child] of value) {
      if (typeof key !== 'string') {
        throw new RecordSchemaError('not_a_map', 'record bodies must use text map keys');
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

/** Decode canonical LDC bytes and strict-validate them through `schema`. */
export function decodeWithSchema<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  return schema.parse(ldcToPlain(decode(bytes)));
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
 * unsupported `record_version` or unknown `kind` (§9.1.4).  This is the single
 * entry point a verifier uses to turn untrusted bytes into a validated record.
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
