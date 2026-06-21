// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.0.4 — domain separation + external_aad.  Grammar accept/reject, the
// fixed §10.2.2 array shape, byte-stability, and a differential test that any
// bound-context field change perturbs the bytes (and therefore the signature).

import { describe, expect, it } from 'vitest';
import { decode } from '../cbor/decode.js';
import { compareBytes } from '../cbor/encode.js';
import { buildExternalAad, DomainSeparatorError, domainSeparator } from '../cose/aad.js';
import { bytesToHex } from './hex.js';

describe('domain separator grammar (§9.5)', () => {
  it('builds the exact §9.5 string', () => {
    expect(domainSeparator('prod', 'proof', 'device_signature')).toBe(
      'LCAP-v0.2:prod:proof:device_signature',
    );
    expect(domainSeparator('staging', 'record', 'contribution_event')).toBe(
      'LCAP-v0.2:staging:record:contribution_event',
    );
  });

  it('rejects illegal tokens with the exact reason', () => {
    const reason = (fn: () => unknown): string => {
      try {
        fn();
      } catch (error) {
        if (error instanceof DomainSeparatorError) return error.reason;
      }
      throw new Error('expected DomainSeparatorError');
    };
    expect(reason(() => domainSeparator('PROD', 'proof', 'x'))).toBe('bad_network_id');
    expect(reason(() => domainSeparator('prod', 'thread', 'x'))).toBe('bad_object_kind');
    expect(reason(() => domainSeparator('prod', 'proof', 'Device_Sig'))).toBe('bad_purpose');
    expect(reason(() => domainSeparator('prod', 'proof', '9bad'))).toBe('bad_purpose');
  });
});

describe('buildExternalAad (§10.2.2)', () => {
  const base = {
    separator: domainSeparator('prod', 'proof', 'device_signature'),
    networkId: 'prod',
    recordKind: 'contribution_event',
    proofKind: 'device_signature',
  } as const;

  it('is the LDC encoding of the fixed 5-element array', () => {
    const aad = buildExternalAad(base);
    const decoded = decode(aad);
    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded).toEqual([
      'LCAP-v0.2:prod:proof:device_signature',
      2,
      'prod',
      'contribution_event',
      'device_signature',
    ]);
    expect(bytesToHex(aad).startsWith('85')).toBe(true); // definite-length 5-array head
  });

  it('is byte-stable across calls', () => {
    expect(compareBytes(buildExternalAad(base), buildExternalAad(base))).toBe(0);
  });

  it('perturbs the bytes when any bound field changes (differential)', () => {
    const reference = buildExternalAad(base);
    const variants = [
      { ...base, separator: domainSeparator('staging', 'proof', 'device_signature') },
      { ...base, protocolVersion: 3 },
      { ...base, networkId: 'staging' },
      { ...base, recordKind: 'device_certificate' },
      { ...base, proofKind: 'witness_signature' },
    ];
    for (const variant of variants) {
      expect(compareBytes(buildExternalAad(variant), reference)).not.toBe(0);
    }
  });
});
