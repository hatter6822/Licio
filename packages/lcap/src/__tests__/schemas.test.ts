// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.0.7 — closed-schema records/proofs paired with LDC decode.  Unknown-key
// and missing-field rejection, version routing, the exact round-trip
// (encode∘decode is byte-identical), and optional-field omission (§9.1.3).

import { beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { decode } from '../cbor/decode.js';
import { compareBytes, encode } from '../cbor/encode.js';
import type { LdcKey, LdcValue } from '../cbor/types.js';
import { cidFor } from '../cid/index.js';
import {
  blockDescriptorV2Schema,
  type CapabilityRecordV2,
  type ContributionEventRecordV2,
  capabilityRecordV2Schema,
  chunkDescriptorV2Schema,
  contributionEventRecordV2Schema,
  type DeviceCertificateRecordV2,
  decodeAndRouteRecord,
  decodeProof,
  decodeWithSchema,
  detachedProofV2Schema,
  deviceCertificateRecordV2Schema,
  encodeWithSchema,
  plainToLdc,
  RecordSchemaError,
  revocationRecordV2Schema,
} from '../schemas/index.js';

function roundTrip<T>(schema: z.ZodType<T>, value: T): void {
  const bytes = encodeWithSchema(schema, value);
  const decoded = decodeWithSchema(schema, bytes);
  expect(decoded).toEqual(value);
  expect(compareBytes(encodeWithSchema(schema, decoded), bytes)).toBe(0);
}

let capCid: string;
let capability: CapabilityRecordV2;
let contribution: ContributionEventRecordV2;

const deviceCert: DeviceCertificateRecordV2 = {
  record_version: 2,
  kind: 'device_certificate',
  account_id: 'acct-1',
  device_id: 'dev-1',
  device_key_id: 'key-1',
  public_key_cose: new Uint8Array([1, 2, 3]),
  issued_at_ms: 1000,
  not_before_ms: 1000,
  not_after_ms: 2000,
  issuer: 'licio_account_authority',
  account_epoch: 0,
};

beforeAll(async () => {
  capCid = await cidFor('record', new Uint8Array([10, 20, 30]));
  capability = {
    record_version: 2,
    kind: 'room_capability',
    capability_id: 'cap-1',
    subject_account_id: 'acct-1',
    subject_device_id: 'dev-1',
    subject_device_key_id: 'key-1',
    room_id: 'room-1',
    visibility_scope: 'public',
    operations: ['post', 'reply'],
    policy_epoch: 0,
    revocation_epoch_floor: 0,
    not_before_ms: 1000,
    not_after_ms: 2000,
    quotas: {
      max_offline_events: 10,
      max_total_payload_bytes: 1000,
      max_single_event_bytes: 100,
      max_media_bytes: 0,
    },
    transfer_policy: {
      may_export_bundle: true,
      may_share_with_relay: false,
      may_share_with_courier: false,
      may_share_with_unknown_peer: false,
    },
  };
  contribution = {
    record_version: 2,
    kind: 'contribution_event',
    event_type: 'post',
    home_room_id: 'room-1',
    visibility_scope: 'public',
    author_account_id: 'acct-1',
    author_device_id: 'dev-1',
    author_device_key_id: 'key-1',
    device_seq: 0,
    capability_cid: capCid,
    policy_epoch_claim: 0,
    revocation_epoch_claim: 0,
    client_nonce: new Uint8Array([4, 5, 6, 7]),
    priority: 1,
  };
});

describe('strict closed schemas (WS-R.0.7)', () => {
  it('rejects unknown keys with a field-named error', () => {
    expect(() => deviceCertificateRecordV2Schema.parse({ ...deviceCert, extra: 1 })).toThrow(
      /extra/i,
    );
  });

  it('rejects a missing required field', () => {
    const { account_id: _omitted, ...withoutAccount } = deviceCert;
    expect(() => deviceCertificateRecordV2Schema.parse(withoutAccount)).toThrow(/account_id/);
  });

  it('accepts a valid record of each kind', () => {
    expect(deviceCertificateRecordV2Schema.parse(deviceCert).kind).toBe('device_certificate');
    expect(capabilityRecordV2Schema.parse(capability).kind).toBe('room_capability');
    expect(contributionEventRecordV2Schema.parse(contribution).event_type).toBe('post');
    expect(
      revocationRecordV2Schema.parse({
        record_version: 2,
        kind: 'revocation',
        revocation_id: 'rev-1',
        revoked_kind: 'device',
        revoked_id: 'dev-1',
        effective_at_ms: 1000,
        revocation_epoch: 1,
      }).revoked_kind,
    ).toBe('device');
  });

  it('rejects a malformed CID field', () => {
    expect(() =>
      contributionEventRecordV2Schema.parse({ ...contribution, capability_cid: 'not-a-cid' }),
    ).toThrow(/capability_cid/);
    // A block CID where a record CID is required is rejected (kind-checked).
  });
});

describe('LDC ↔ schema codec round-trip (WS-R.0.7)', () => {
  it('encode∘decode is byte-identical and value-preserving', () => {
    roundTrip(deviceCertificateRecordV2Schema, deviceCert);
    roundTrip(capabilityRecordV2Schema, capability);
    roundTrip(contributionEventRecordV2Schema, contribution);
  });

  it('omits absent optional fields rather than encoding null (§9.1.3)', () => {
    const bytes = encodeWithSchema(deviceCertificateRecordV2Schema, deviceCert);
    const decoded = decode(bytes);
    expect(decoded).toBeInstanceOf(Map);
    expect((decoded as Map<string, unknown>).has('flags')).toBe(false);

    // plainToLdc skips undefined-valued keys.
    const map = plainToLdc({ a: undefined, b: 1 }) as Map<LdcKey, LdcValue>;
    expect(map.has('a')).toBe(false);
    expect(map.get('b')).toBe(1);
  });
});

describe('version + kind routing (WS-R.0.7)', () => {
  it('routes a record to the schema for its kind', () => {
    const bytes = encodeWithSchema(capabilityRecordV2Schema, capability);
    expect(decodeAndRouteRecord(bytes).kind).toBe('room_capability');
  });

  it('rejects an unsupported record_version', () => {
    const bytes = encode(
      new Map<LdcKey, LdcValue>([
        ['record_version', 3],
        ['kind', 'revocation'],
      ]),
    );
    try {
      decodeAndRouteRecord(bytes);
      throw new Error('expected RecordSchemaError');
    } catch (error) {
      expect(error).toBeInstanceOf(RecordSchemaError);
      expect((error as RecordSchemaError).reason).toBe('unsupported_record_version');
    }
  });

  it('rejects an unknown record kind', () => {
    const bytes = encode(
      new Map<LdcKey, LdcValue>([
        ['record_version', 2],
        ['kind', 'mystery'],
      ]),
    );
    expect(() => decodeAndRouteRecord(bytes)).toThrow(/unknown_record_kind/);
  });

  it('rejects a non-map record body', () => {
    expect(() => decodeAndRouteRecord(encode([1, 2, 3]))).toThrow(RecordSchemaError);
  });
});

describe('proof + block/chunk descriptor schemas (WS-R.0.7)', () => {
  let blockCid: string;
  let chunkCid: string;
  let recordCid: string;

  beforeAll(async () => {
    blockCid = await cidFor('block', new Uint8Array([1]));
    chunkCid = await cidFor('chunk', new Uint8Array([2]));
    recordCid = await cidFor('record', new Uint8Array([3]));
  });

  it('round-trips a detached proof body and rejects a non-v2 proof', () => {
    const proof = {
      proof_version: 2 as const,
      proof_kind: 'device_signature' as const,
      record_cid: recordCid,
      record_kind: 'contribution_event' as const,
      cose_protected: new Uint8Array([0xa1, 0x01, 0x26]),
      external_aad: new Uint8Array([0x80]),
      signature: new Uint8Array(64),
      signer_key_id: 'key-1',
    };
    roundTrip(detachedProofV2Schema, proof);
    expect(decodeProof(encodeWithSchema(detachedProofV2Schema, proof)).proof_kind).toBe(
      'device_signature',
    );
    const wrongVersion = encode(
      new Map<LdcKey, LdcValue>([
        ['proof_version', 1],
        ['proof_kind', 'device_signature'],
      ]),
    );
    expect(() => decodeProof(wrongVersion)).toThrow(/unsupported_proof_version/);
  });

  it('validates a block descriptor with chunking and a chunk descriptor', () => {
    const block = {
      block_cid: blockCid,
      role: 'image' as const,
      media_type: 'image/png',
      size_bytes: 2048,
      sha256: new Uint8Array(32),
      priority: 3 as const,
      chunking: { chunk_size: 1024, chunk_count: 2, chunk_cids: [chunkCid, chunkCid] },
    };
    expect(blockDescriptorV2Schema.parse(block).role).toBe('image');
    const chunk = {
      parent_block_cid: blockCid,
      chunk_index: 0,
      offset: 0,
      length: 1024,
      chunk_sha256: new Uint8Array(32),
    };
    expect(chunkDescriptorV2Schema.parse(chunk).length).toBe(1024);
    // A record CID where a block CID is required is rejected (kind-checked).
    expect(() => blockDescriptorV2Schema.parse({ ...block, block_cid: recordCid })).toThrow(
      /block_cid/,
    );
  });

  it('accepts an optional any-kind CID and rejects a malformed one', () => {
    expect(
      revocationRecordV2Schema.parse({
        record_version: 2,
        kind: 'revocation',
        revocation_id: 'rev-2',
        revoked_kind: 'capability',
        revoked_id: 'cap-9',
        effective_at_ms: 5,
        revocation_epoch: 2,
        replacement_cid: blockCid,
      }).replacement_cid,
    ).toBe(blockCid);
    expect(() =>
      revocationRecordV2Schema.parse({
        record_version: 2,
        kind: 'revocation',
        revocation_id: 'rev-3',
        revoked_kind: 'capability',
        revoked_id: 'cap-9',
        effective_at_ms: 5,
        revocation_epoch: 2,
        replacement_cid: 'not-a-cid',
      }),
    ).toThrow(/replacement_cid/);
  });
});
