// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.7 — the IPFS bridge: the LCAP block_cid ⇄ IPFS CIDv1(raw, sha2-256) mapping
// is verification-preserving (same digest, canonical `bafkrei…` form); a fetched block
// is RE-VERIFIED against its block_cid (a tampering gateway is rejected — no transport
// trust); and publishing is structurally public-only (in_room/private/ciphertext/
// taken-down are refused).

import { cidFor } from '@licio/lcap';
import { describe, expect, it } from 'vitest';
import {
  decideBlockPublish,
  IpfsBridge,
  ipfsCidForBlockCid,
  ipfsCidV1FromDigest,
  multibaseBase32,
} from '../index.js';

describe('CID mapping (§9.2/§22.7)', () => {
  it('encodes multibase-b base32 with the b prefix', () => {
    expect(multibaseBase32(new Uint8Array([0]))[0]).toBe('b');
  });

  it('emits no trailing-bit char when the input is an exact multiple of 5 bytes', () => {
    // 5 bytes = 40 bits = exactly 8 base32 symbols, so the `bits > 0` tail is NOT taken.
    // Every 5-bit group is 0b11111 = 31 → alphabet index 31 = '7'.
    const out = multibaseBase32(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]));
    expect(out).toBe('b77777777'); // 'b' prefix + 8 sevens, no trailing-bit symbol
    expect(out.length).toBe(1 + 8);
  });

  it('rejects a non-32-byte digest', () => {
    expect(() => ipfsCidV1FromDigest(new Uint8Array(31))).toThrow();
  });

  it('maps a real block CID to the canonical CIDv1(raw, sha2-256) form', async () => {
    const blockCid = await cidFor('block', new TextEncoder().encode('hello block'));
    const ipfsCid = ipfsCidForBlockCid(blockCid);
    // CIDv1 raw + sha2-256 always serializes to a `bafkrei…` multibase-b base32 string.
    expect(ipfsCid.startsWith('bafkrei')).toBe(true);
  });

  it('matches the well-known CIDv1 of the empty block (full known-answer, not just the prefix)', () => {
    // sha256("") = e3b0c442…b855; the canonical IPFS CIDv1(raw, sha2-256) of the empty
    // block is a fixed, externally-verifiable value — it pins the WHOLE base32 string, so
    // a 32-bit accumulator overflow anywhere past the prefix would fail this.
    const hex = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const emptySha256 = Uint8Array.from(
      (hex.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)),
    );
    expect(ipfsCidV1FromDigest(emptySha256)).toBe(
      'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
    );
  });

  it('refuses to map a non-block CID (only blocks bridge to the DHT)', async () => {
    const recordCid = await cidFor('record', new TextEncoder().encode('a record'));
    expect(() => ipfsCidForBlockCid(recordCid)).toThrow();
  });
});

describe('public-only publish gate (§37.2)', () => {
  it('publishes only public, unencrypted, non-taken-down blocks', () => {
    expect(
      decideBlockPublish({ visibility: 'public', encrypted: false, takenDown: false }),
    ).toEqual({
      publishable: true,
      reason: '',
    });
    expect(
      decideBlockPublish({ visibility: 'in_room', encrypted: false, takenDown: false }).reason,
    ).toBe('not_public');
    expect(
      decideBlockPublish({ visibility: 'private', encrypted: false, takenDown: false }).reason,
    ).toBe('not_public');
    expect(
      decideBlockPublish({ visibility: 'public', encrypted: true, takenDown: false }).reason,
    ).toBe('encrypted');
    expect(
      decideBlockPublish({ visibility: 'public', encrypted: false, takenDown: true }).reason,
    ).toBe('taken_down');
  });
});

describe('gateway bridge — no transport trust (§22.7)', () => {
  it('returns verified bytes when the gateway serves the correct block', async () => {
    const payload = new TextEncoder().encode('verified public block');
    const blockCid = await cidFor('block', payload);
    const bridge = new IpfsBridge({
      gatewayUrl: 'https://gw.test',
      fetchFn: async () => new Response(payload, { status: 200 }),
    });
    const result = await bridge.fetchBlock(blockCid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes).toEqual(payload);
  });

  it('REJECTS bytes that do not hash to the requested block_cid (cid_mismatch)', async () => {
    const blockCid = await cidFor('block', new TextEncoder().encode('the real block'));
    const bridge = new IpfsBridge({
      gatewayUrl: 'https://gw.test',
      fetchFn: async () => new Response(new TextEncoder().encode('WRONG bytes'), { status: 200 }),
    });
    const result = await bridge.fetchBlock(blockCid);
    expect(result).toEqual({ ok: false, reason: 'cid_mismatch' });
  });

  it('maps a 404 to not_found, a 5xx to gateway_error, and a network error to gateway_error', async () => {
    const blockCid = await cidFor('block', new TextEncoder().encode('x'));
    const notFound = new IpfsBridge({
      gatewayUrl: 'https://gw.test',
      fetchFn: async () => new Response(null, { status: 404 }),
    });
    expect(await notFound.fetchBlock(blockCid)).toEqual({ ok: false, reason: 'not_found' });
    // A non-404 non-ok status (e.g. a 500 from an overloaded gateway) is gateway_error.
    const serverError = new IpfsBridge({
      gatewayUrl: 'https://gw.test',
      fetchFn: async () => new Response(null, { status: 500 }),
    });
    expect(await serverError.fetchBlock(blockCid)).toEqual({ ok: false, reason: 'gateway_error' });
    const erroring = new IpfsBridge({
      gatewayUrl: 'https://gw.test',
      fetchFn: async () => {
        throw new Error('offline');
      },
    });
    expect(await erroring.fetchBlock(blockCid)).toEqual({ ok: false, reason: 'gateway_error' });
  });
});

describe('gateway bridge — publish enforces the gate', () => {
  it('refuses to publish a non-public block and pins a public one', async () => {
    const payload = new TextEncoder().encode('public');
    const blockCid = await cidFor('block', payload);
    let pinned = false;
    const bridge = new IpfsBridge({
      gatewayUrl: 'https://gw.test',
      pinningUrl: 'https://pin.test/add',
      fetchFn: async () => {
        pinned = true;
        return new Response(null, { status: 200 });
      },
    });
    // A non-public decision is refused BEFORE any network call.
    const refused = await bridge.publishBlock(blockCid, payload, {
      publishable: false,
      reason: 'not_public',
    });
    expect(refused).toEqual({ ok: false, reason: 'not_public' });
    expect(pinned).toBe(false);

    const ok = await bridge.publishBlock(blockCid, payload, { publishable: true, reason: '' });
    expect(ok.ok).toBe(true);
    expect(pinned).toBe(true);
  });

  it('refuses to pin bytes that do not hash to the announced block_cid (cid_mismatch)', async () => {
    const blockCid = await cidFor('block', new TextEncoder().encode('the real bytes'));
    let pinned = false;
    const bridge = new IpfsBridge({
      gatewayUrl: 'https://gw.test',
      pinningUrl: 'https://pin.test/add',
      fetchFn: async () => {
        pinned = true;
        return new Response(null, { status: 200 });
      },
    });
    const res = await bridge.publishBlock(blockCid, new TextEncoder().encode('WRONG bytes'), {
      publishable: true,
      reason: '',
    });
    expect(res).toEqual({ ok: false, reason: 'cid_mismatch' });
    expect(pinned).toBe(false); // verified BEFORE any network call
  });

  it('reports no_pinning_endpoint when no pinning URL is configured', async () => {
    const payload = new TextEncoder().encode('public');
    const blockCid = await cidFor('block', payload);
    const bridge = new IpfsBridge({ gatewayUrl: 'https://gw.test' });
    expect(await bridge.publishBlock(blockCid, payload, { publishable: true, reason: '' })).toEqual(
      {
        ok: false,
        reason: 'no_pinning_endpoint',
      },
    );
  });

  it('maps a non-ok pin response and a thrown pin to pin_error', async () => {
    const payload = new TextEncoder().encode('public');
    const blockCid = await cidFor('block', payload);
    const rejecting = new IpfsBridge({
      gatewayUrl: 'https://gw.test',
      pinningUrl: 'https://pin.test/add',
      fetchFn: async () => new Response(null, { status: 500 }),
    });
    expect(
      await rejecting.publishBlock(blockCid, payload, { publishable: true, reason: '' }),
    ).toEqual({ ok: false, reason: 'pin_error' });
    const throwing = new IpfsBridge({
      gatewayUrl: 'https://gw.test',
      pinningUrl: 'https://pin.test/add',
      fetchFn: async () => {
        throw new Error('network down');
      },
    });
    expect(
      await throwing.publishBlock(blockCid, payload, { publishable: true, reason: '' }),
    ).toEqual({ ok: false, reason: 'pin_error' });
  });

  it('returns the IPFS CID on a successful pin', async () => {
    const payload = new TextEncoder().encode('public-ok');
    const blockCid = await cidFor('block', payload);
    const bridge = new IpfsBridge({
      gatewayUrl: 'https://gw.test',
      pinningUrl: 'https://pin.test/add',
      fetchFn: async () => new Response(null, { status: 200 }),
    });
    const res = await bridge.publishBlock(blockCid, payload, { publishable: true, reason: '' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.ipfsCid).toBe(ipfsCidForBlockCid(blockCid));
  });
});
