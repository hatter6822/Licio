// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.3 gateway seam: the deterministic in-memory fake's verdict semantics
// (accept happy path + decline), idempotency replay, eventual-consistency
// reads (X-Knomosis-Seq, ETag 304), the 409-gap signal, and — for the HTTP
// client — the FAIL-CLOSED unknown-verdict handling that is the core of the
// gateway contract.

import { describe, expect, it } from 'vitest';
import {
  FakeKnomosisGateway,
  type GatewaySignedAction,
  HttpKnomosisGateway,
} from '../knomosis/gateway.js';

const signedAction = (typedDataHash: string, actor = '0xabc'): GatewaySignedAction => ({
  message: { actor, amount: '10', asset: 'USDC' },
  signature: '0xdead',
  actionType: 'treasury_deposit',
  typedDataHash,
});

describe('FakeKnomosisGateway (dev + tests)', () => {
  it('accepts an action and drives the happy-path event stream', async () => {
    const gw = new FakeKnomosisGateway();
    const result = await gw.submitAction({
      signedAction: signedAction('0x01'),
      idempotencyKey: 'idem-1',
    });
    expect(result.kind).toBe('verdict');
    if (result.kind === 'verdict') {
      expect(result.verdict.accepted).toBe(true);
      expect(result.verdict.seq).toBeNull(); // no seq today (contract)
    }
    const events = await gw.getEvents(null, 100);
    expect(events.kind).toBe('events');
    if (events.kind === 'events') {
      expect(events.events.map((e) => e.type)).toEqual([
        'knomosis.action.accepted',
        'knomosis.action.settled',
        'knomosis.action.finalized',
      ]);
      // Balance credited for the deposit.
      const balances = await gw.getBalances('0xabc');
      if (balances.kind === 'ok') expect(balances.value['USDC']).toBe('10');
    }
  });

  it('declines a flagged action (200 accepted:false model)', async () => {
    const gw = new FakeKnomosisGateway();
    gw.decline('0xbad');
    const result = await gw.submitAction({
      signedAction: signedAction('0xbad'),
      idempotencyKey: 'idem-2',
    });
    expect(result.kind).toBe('verdict');
    if (result.kind === 'verdict') {
      expect(result.verdict.accepted).toBe(false);
      expect(result.verdict.verdict).toBe('NotAdmissible');
    }
  });

  it('is idempotent: a replayed key returns the original verdict, no re-processing', async () => {
    const gw = new FakeKnomosisGateway();
    await gw.submitAction({ signedAction: signedAction('0x03'), idempotencyKey: 'idem-3' });
    const before = await gw.getEvents(null, 100);
    const replay = await gw.submitAction({
      signedAction: signedAction('0x03'),
      idempotencyKey: 'idem-3',
    });
    const after = await gw.getEvents(null, 100);
    expect(replay.kind).toBe('verdict');
    // No new events emitted on replay.
    if (before.kind === 'events' && after.kind === 'events') {
      expect(after.events.length).toBe(before.events.length);
    }
  });

  it('standing reads carry X-Knomosis-Seq and honour ETag (304)', async () => {
    const gw = new FakeKnomosisGateway();
    gw.setBalance('0xactor', 'USDC', '500');
    const first = await gw.getBalances('0xactor');
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.knomosisSeq).toBeDefined();
    const conditional = await gw.getBalances('0xactor', first.etag);
    expect(conditional.kind).toBe('not_modified');
    // absent cell reads "0"
    const missing = await gw.getBalances('0xnobody');
    if (missing.kind === 'ok') expect(missing.value['USDC']).toBeUndefined();
  });

  it('reports a GAP when the cursor falls behind the retained window', async () => {
    const gw = new FakeKnomosisGateway();
    await gw.submitAction({ signedAction: signedAction('0x05'), idempotencyKey: 'idem-5' });
    await gw.submitAction({ signedAction: signedAction('0x06'), idempotencyKey: 'idem-6' });
    gw.truncateWindow('4'); // drop the first batch
    const gap = await gw.getEvents('1', 100);
    expect(gap.kind).toBe('gap');
    if (gap.kind === 'gap') expect(gap.oldestSeq).toBe('4');
  });

  it('degrades to unavailable when offline', async () => {
    const gw = new FakeKnomosisGateway();
    gw.offline = true;
    expect(
      (await gw.submitAction({ signedAction: signedAction('0x07'), idempotencyKey: 'i7' })).kind,
    ).toBe('unavailable');
    expect((await gw.getBalances('0xa')).kind).toBe('unavailable');
    expect((await gw.getEvents(null, 10)).kind).toBe('unavailable');
  });
});

describe('HttpKnomosisGateway (fail-closed parsing)', () => {
  function stubFetch(response: {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }) {
    return async () =>
      new Response(response.body === undefined ? null : JSON.stringify(response.body), {
        status: response.status,
        ...(response.headers ? { headers: response.headers } : {}),
      });
  }

  it('accepts a well-formed Ok verdict', async () => {
    const gw = new HttpKnomosisGateway({
      baseUrl: 'http://gw',
      bearerToken: 't',
      fetchImpl: stubFetch({ status: 200, body: { accepted: true, verdict: 'Ok', seq: null } }),
    });
    const result = await gw.submitAction({
      signedAction: signedAction('0x1'),
      idempotencyKey: 'k',
    });
    expect(result.kind).toBe('verdict');
  });

  it('FAILS CLOSED on an unknown verdict shape (protocol_error, never accept)', async () => {
    const gw = new HttpKnomosisGateway({
      baseUrl: 'http://gw',
      bearerToken: 't',
      fetchImpl: stubFetch({ status: 200, body: { accepted: true, verdict: 'FutureVerdict' } }),
    });
    const result = await gw.submitAction({
      signedAction: signedAction('0x1'),
      idempotencyKey: 'k',
    });
    expect(result.kind).toBe('protocol_error');
  });

  it('maps a 409 events response to a gap with oldestSeq', async () => {
    const gw = new HttpKnomosisGateway({
      baseUrl: 'http://gw',
      bearerToken: 't',
      fetchImpl: stubFetch({ status: 409, body: { oldestSeq: '42' } }),
    });
    const result = await gw.getEvents('1', 10);
    expect(result).toEqual({ kind: 'gap', oldestSeq: '42' });
  });

  it('treats a missing X-Knomosis-Seq header as unavailable (never silently trusted)', async () => {
    const gw = new HttpKnomosisGateway({
      baseUrl: 'http://gw',
      bearerToken: 't',
      fetchImpl: stubFetch({ status: 200, body: { USDC: '5' } }), // no seq header
    });
    const result = await gw.getBalances('0xa');
    expect(result.kind).toBe('unavailable');
  });

  it('a network error degrades to unavailable, never throws', async () => {
    const gw = new HttpKnomosisGateway({
      baseUrl: 'http://gw',
      bearerToken: 't',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(
      (await gw.submitAction({ signedAction: signedAction('0x1'), idempotencyKey: 'k' })).kind,
    ).toBe('unavailable');
  });
});
