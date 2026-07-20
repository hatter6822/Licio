// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal AWS Signature Version 4 request signer (header-based) on node:crypto.
// The S3 surface the export pipeline needs is four verbs, so a full AWS SDK
// (and its transitive tree) fails the dependency-addition checklist; SigV4 is
// a small, stable, precisely specified algorithm.  Correctness is pinned by
// the official AWS worked example in sigv4.test.ts at all three levels
// (canonical-request hash, string-to-sign, final signature).
//
// Reference: AWS General Reference, "Signature Version 4 signing process".
import { createHmac } from 'node:crypto';
import { sha256Hex } from './crypto.js';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** e.g. 's3' */
  service: string;
}

export interface SigV4Request {
  method: string;
  url: URL;
  /**
   * Headers to sign IN ADDITION to `host` and `x-amz-date`, which the signer
   * derives and always signs.  Names are case-insensitive.
   */
  headers: Record<string, string>;
  /** Lowercase hex sha256 of the request payload (of '' for empty bodies). */
  payloadHash: string;
}

/** RFC 3986 strict percent-encoding; object keys keep their '/' separators. */
export function uriEncode(value: string, encodeSlash: boolean): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return encodeSlash ? encoded : encoded.replace(/%2F/gi, '/');
}

/** 20150830T123600Z — the SigV4 timestamp format. */
export function toAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/** Canonical header value: trimmed, internal whitespace runs collapsed. */
const canonicalValue = (value: string): string => value.trim().replace(/\s+/g, ' ');

/** The derived pieces every SigV4 step shares. */
function prepare(
  req: SigV4Request,
  date: Date,
): { headers: Map<string, string>; signedHeaders: string; canonicalRequest: string } {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(req.headers)) {
    headers.set(name.toLowerCase(), canonicalValue(value));
  }
  headers.set('host', req.url.host);
  headers.set('x-amz-date', toAmzDate(date));

  const signedNames = [...headers.keys()].sort();
  const signedHeaders = signedNames.join(';');

  const canonicalQuery = [...req.url.searchParams]
    .map(([k, v]) => [uriEncode(k, true), uriEncode(v, true)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    req.method.toUpperCase(),
    req.url.pathname || '/',
    canonicalQuery,
    signedNames.map((n) => `${n}:${headers.get(n)}\n`).join(''),
    signedHeaders,
    req.payloadHash,
  ].join('\n');

  return { headers, signedHeaders, canonicalRequest };
}

/** Exposed for the vector test: the canonical request string. */
export function canonicalRequestOf(req: SigV4Request, date: Date): string {
  return prepare(req, date).canonicalRequest;
}

/** Exposed for the vector test: the string to sign. */
export function stringToSignOf(req: SigV4Request, creds: SigV4Credentials, date: Date): string {
  const dateStamp = toAmzDate(date).slice(0, 8);
  const scope = `${dateStamp}/${creds.region}/${creds.service}/aws4_request`;
  return [
    'AWS4-HMAC-SHA256',
    toAmzDate(date),
    scope,
    sha256Hex(prepare(req, date).canonicalRequest),
  ].join('\n');
}

/**
 * Sign a request: returns ALL headers to send — the caller's headers plus
 * `host`, `x-amz-date`, and `authorization`.
 */
export function signRequest(
  req: SigV4Request,
  creds: SigV4Credentials,
  date: Date = new Date(),
): Record<string, string> {
  const { headers, signedHeaders } = prepare(req, date);
  const dateStamp = toAmzDate(date).slice(0, 8);
  const scope = `${dateStamp}/${creds.region}/${creds.service}/aws4_request`;

  let key = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  key = hmac(key, creds.region);
  key = hmac(key, creds.service);
  key = hmac(key, 'aws4_request');
  const signature = createHmac('sha256', key)
    .update(stringToSignOf(req, creds, date), 'utf8')
    .digest('hex');

  return {
    ...Object.fromEntries(headers),
    authorization:
      `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
