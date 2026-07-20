// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SigV4 signer validated against the OFFICIAL AWS worked example ("Signature
// Version 4 signing process — complete example", AWS General Reference):
// access key AKIDEXAMPLE signing GET https://iam.amazonaws.com/?Action=
// ListUsers&Version=2010-05-08 at 20150830T123600Z.  The expected canonical-
// request hash, string-to-sign, and signature below are the published values,
// so a regression at ANY stage of the algorithm pinpoints itself.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalRequestOf,
  type SigV4Credentials,
  type SigV4Request,
  signRequest,
  stringToSignOf,
  toAmzDate,
  uriEncode,
} from '../sigv4.js';

const VECTOR_DATE = new Date('2015-08-30T12:36:00Z');
const VECTOR_CREDS: SigV4Credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'iam',
};
const EMPTY_HASH = createHash('sha256').update('').digest('hex');
const VECTOR_REQUEST: SigV4Request = {
  method: 'GET',
  url: new URL('https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08'),
  headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
  payloadHash: EMPTY_HASH,
};

describe('SigV4 against the official AWS worked example', () => {
  it('produces the published canonical-request hash', () => {
    const canonical = canonicalRequestOf(VECTOR_REQUEST, VECTOR_DATE);
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(
      'f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59',
    );
  });

  it('produces the published string to sign', () => {
    expect(stringToSignOf(VECTOR_REQUEST, VECTOR_CREDS, VECTOR_DATE)).toBe(
      'AWS4-HMAC-SHA256\n' +
        '20150830T123600Z\n' +
        '20150830/us-east-1/iam/aws4_request\n' +
        'f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59',
    );
  });

  it('produces the published signature and Authorization header', () => {
    const headers = signRequest(VECTOR_REQUEST, VECTOR_CREDS, VECTOR_DATE);
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date, ' +
        'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
    expect(headers['host']).toBe('iam.amazonaws.com');
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
  });
});

describe('SigV4 building blocks', () => {
  it('formats the amz-date timestamp', () => {
    expect(toAmzDate(new Date('2026-01-02T03:04:05.678Z'))).toBe('20260102T030405Z');
  });

  it('strict-encodes per RFC 3986, preserving slashes only when asked', () => {
    expect(uriEncode("a b!c'd(e)f*g~h-i_j.k", true)).toBe('a%20b%21c%27d%28e%29f%2Ag~h-i_j.k');
    expect(uriEncode('export/abc def', false)).toBe('export/abc%20def');
    expect(uriEncode('export/abc', true)).toBe('export%2Fabc');
  });

  it('sorts query parameters by name then value and signs them', () => {
    const req: SigV4Request = {
      method: 'GET',
      url: new URL('https://s3.example.com/bucket?prefix=export/&list-type=2'),
      headers: {},
      payloadHash: EMPTY_HASH,
    };
    const canonical = canonicalRequestOf(req, VECTOR_DATE);
    const queryLine = canonical.split('\n')[2];
    expect(queryLine).toBe('list-type=2&prefix=export%2F');
  });

  it('sorts query keys by UTF-16 code point, not locale (uppercase before lowercase)', () => {
    const req: SigV4Request = {
      method: 'GET',
      url: new URL('https://s3.example.com/bucket?delimiter=/&Marker=x'),
      headers: {},
      payloadHash: EMPTY_HASH,
    };
    const canonical = canonicalRequestOf(req, VECTOR_DATE);
    const queryLine = canonical.split('\n')[2];
    // 'M' (0x4D) precedes 'd' (0x64) in code-point order; localeCompare would
    // reverse this on many locales, breaking the AWS canonical ordering.
    expect(queryLine).toBe('Marker=x&delimiter=%2F');
  });
});
