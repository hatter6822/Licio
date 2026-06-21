// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Exchange request/response assembly + status handling (§16.3, §16.4, §16.5,
// WS-R.6.2): schema-valid envelopes carrying pulse + interests + statuses, and
// the client directive / retry / budget rules honored verbatim.

import { beforeAll, describe, expect, it } from 'vitest';
import { cidFor } from '../cid/index.js';
import {
  exchangeRequestV2Schema,
  exchangeResponseV2Schema,
  type InterestDescriptorV2,
} from '../schemas/index.js';
import {
  buildExchangeRequest,
  buildExchangeResponse,
  buildPulse,
  clientDirectiveForStatus,
  DEFAULT_BUDGET,
  exchangeComplete,
  packWithinBudget,
  shouldRetry,
} from '../sync/index.js';

let recordCid: string;

const pulse = () =>
  buildPulse({
    nodeId: 'node-1',
    sessionNonce: new Uint8Array([1]),
    transportProfile: 'https',
    privacyMode: 'public',
    budgets: DEFAULT_BUDGET,
    supportedSuites: ['ES256'],
    supportedCompression: ['gzip'],
    supportedPackVersions: [2],
    checkpointFrontier: [],
    revocationFrontier: [],
  });

const interest: InterestDescriptorV2 = {
  interest_version: 2,
  include_dependencies: true,
  include_proofs: true,
  privacy_level: 'public',
};

beforeAll(async () => {
  recordCid = await cidFor('record', new TextEncoder().encode('r-1'));
});

describe('buildExchangeRequest / buildExchangeResponse (§16.3, §16.4)', () => {
  it('assembles a schema-valid request with pulse + interests, omitting absent optionals', () => {
    const req = buildExchangeRequest({ pulse: pulse(), interests: [interest] });
    expect(() => exchangeRequestV2Schema.parse(req)).not.toThrow();
    expect(req.interests).toHaveLength(1);
    expect('push_pack' in req).toBe(false);
    expect('want' in req).toBe(false);
  });

  it('carries a push pack and wants when provided', () => {
    const req = buildExchangeRequest({
      pulse: pulse(),
      interests: [interest],
      pushPack: new Uint8Array([1, 2, 3]),
      want: [{ cid: recordCid, cid_kind: 'record', reason: 'explicit_user_request' }],
    });
    expect(req.push_pack).toEqual(new Uint8Array([1, 2, 3]));
    expect(req.want).toHaveLength(1);
  });

  it('assembles a schema-valid response with status + accepted statuses', () => {
    const res = buildExchangeResponse({
      pulse: pulse(),
      status: 'partial',
      acceptedPush: [{ cid: recordCid, cid_kind: 'record', status: 'accepted' }],
    });
    expect(() => exchangeResponseV2Schema.parse(res)).not.toThrow();
    expect(res.status).toBe('partial');
    expect(res.accepted_push).toHaveLength(1);
  });

  it('populates retry_after_ms when rate limited', () => {
    const res = buildExchangeResponse({
      pulse: pulse(),
      status: 'rate_limited',
      retryAfterMs: 5000,
    });
    expect(res.retry_after_ms).toBe(5000);
  });
});

describe('status handling (§16.4)', () => {
  it('maps each status to the client directive', () => {
    expect(clientDirectiveForStatus('ok')).toBe('proceed');
    expect(clientDirectiveForStatus('partial')).toBe('continue');
    expect(clientDirectiveForStatus('rate_limited')).toBe('retry');
    expect(clientDirectiveForStatus('retry_later')).toBe('retry');
    expect(clientDirectiveForStatus('auth_required')).toBe('reauthenticate');
  });

  it('flags retry and completion', () => {
    expect(shouldRetry('rate_limited')).toBe(true);
    expect(shouldRetry('retry_later')).toBe(true);
    expect(shouldRetry('ok')).toBe(false);
    expect(exchangeComplete('ok')).toBe(true);
    expect(exchangeComplete('partial')).toBe(false);
  });

  it('enforces pack size against the correct budget side', () => {
    expect(packWithinBudget(DEFAULT_BUDGET.max_response_bytes, DEFAULT_BUDGET, 'response')).toBe(
      true,
    );
    expect(
      packWithinBudget(DEFAULT_BUDGET.max_response_bytes + 1, DEFAULT_BUDGET, 'response'),
    ).toBe(false);
    expect(packWithinBudget(DEFAULT_BUDGET.max_request_bytes + 1, DEFAULT_BUDGET, 'request')).toBe(
      false,
    );
  });
});
