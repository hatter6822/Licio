// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A small tagged-JSON representation so the normative conformance corpus
// (`src/test-vectors/*.json`) can hold LDC values — which include byte strings,
// bigints, and integer-keyed maps that plain JSON cannot express.  `toTagged`
// emits the corpus (generator side); `fromTagged` materializes it (test side).

import type { LdcKey, LdcValue } from '../cbor/types.js';
import { bytesToHex, hexToBytes } from './hex.js';

export type TaggedValue =
  | number
  | boolean
  | null
  | string
  | { readonly $bigint: string }
  | { readonly $bytes: string }
  | TaggedValue[]
  | { readonly $map: Array<[TaggedValue, TaggedValue]> };

/** Materialize a tagged JSON value into the LDC value it denotes. */
export function fromTagged(tagged: TaggedValue): LdcValue {
  if (tagged === null) return null;
  if (typeof tagged === 'number' || typeof tagged === 'boolean' || typeof tagged === 'string') {
    return tagged;
  }
  if (Array.isArray(tagged)) {
    return tagged.map((child) => fromTagged(child));
  }
  if ('$bigint' in tagged) return BigInt(tagged.$bigint);
  if ('$bytes' in tagged) return hexToBytes(tagged.$bytes);
  const map = new Map<LdcKey, LdcValue>();
  for (const [key, value] of tagged.$map) {
    map.set(fromTagged(key) as LdcKey, fromTagged(value));
  }
  return map;
}

/** Serialize an LDC value into its tagged JSON representation. */
export function toTagged(value: LdcValue): TaggedValue {
  if (value === null) return null;
  if (value instanceof Uint8Array) return { $bytes: bytesToHex(value) };
  if (value instanceof Map) {
    const pairs: Array<[TaggedValue, TaggedValue]> = [];
    for (const [key, child] of value) pairs.push([toTagged(key), toTagged(child)]);
    return { $map: pairs };
  }
  if (Array.isArray(value)) return value.map((child) => toTagged(child));
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  throw new Error('unreachable: unsupported LDC value in toTagged');
}
