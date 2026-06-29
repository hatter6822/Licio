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
  assertPublicGatewayEligible,
  decideBlockPublish,
  IpfsBridge,
  ipfsCidForBlockCid,
  ipfsCidV1FromDigest,
  multibaseBase32,
  republicationSet,
  TAKEDOWN_STATUSES,
  type TakedownStatus,
  takedownHaltsPublish,
  takedownInForce,
} from '../index.js';

/** The WS-S.4.4 eligibility signals for genuinely-public content (now a required arg). */
const PUBLIC_GATEWAY = {
  visibility: 'public',
  encrypted: false,
  takenDown: false,
  privateRoomCid: false,
} as const;

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
    const refused = await bridge.publishBlock(
      blockCid,
      payload,
      { publishable: false, reason: 'not_public' },
      PUBLIC_GATEWAY,
    );
    expect(refused).toEqual({ ok: false, reason: 'not_public' });
    expect(pinned).toBe(false);

    const ok = await bridge.publishBlock(
      blockCid,
      payload,
      { publishable: true, reason: '' },
      PUBLIC_GATEWAY,
    );
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
    const res = await bridge.publishBlock(
      blockCid,
      new TextEncoder().encode('WRONG bytes'),
      { publishable: true, reason: '' },
      PUBLIC_GATEWAY,
    );
    expect(res).toEqual({ ok: false, reason: 'cid_mismatch' });
    expect(pinned).toBe(false); // verified BEFORE any network call
  });

  it('reports no_pinning_endpoint when no pinning URL is configured', async () => {
    const payload = new TextEncoder().encode('public');
    const blockCid = await cidFor('block', payload);
    const bridge = new IpfsBridge({ gatewayUrl: 'https://gw.test' });
    expect(
      await bridge.publishBlock(
        blockCid,
        payload,
        { publishable: true, reason: '' },
        PUBLIC_GATEWAY,
      ),
    ).toEqual({
      ok: false,
      reason: 'no_pinning_endpoint',
    });
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
      await rejecting.publishBlock(
        blockCid,
        payload,
        { publishable: true, reason: '' },
        PUBLIC_GATEWAY,
      ),
    ).toEqual({ ok: false, reason: 'pin_error' });
    const throwing = new IpfsBridge({
      gatewayUrl: 'https://gw.test',
      pinningUrl: 'https://pin.test/add',
      fetchFn: async () => {
        throw new Error('network down');
      },
    });
    expect(
      await throwing.publishBlock(
        blockCid,
        payload,
        { publishable: true, reason: '' },
        PUBLIC_GATEWAY,
      ),
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
    const res = await bridge.publishBlock(
      blockCid,
      payload,
      { publishable: true, reason: '' },
      PUBLIC_GATEWAY,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.ipfsCid).toBe(ipfsCidForBlockCid(blockCid));
  });
});

describe('Gate-19 — takedown status policy (§22.7, §36 gate 19)', () => {
  it('mirrors the WS-J takedownStatusEnum membership (no drift)', () => {
    // Pinned literally because @licio/lcap-p2p may not import @licio/db; this is the
    // no-drift guard against the packages/db `takedownStatusEnum`.
    expect([...TAKEDOWN_STATUSES]).toEqual(['received', 'under_review', 'actioned', 'rejected']);
  });

  it('halts republication ONLY for `actioned` (not pre-review or rejected)', () => {
    expect(takedownInForce('actioned')).toBe(true);
    // Halting earlier would weaponize the takedown intake (a censorship vector);
    // halting on `rejected` would honor a dismissed claim.
    for (const status of ['received', 'under_review', 'rejected'] satisfies TakedownStatus[]) {
      expect(takedownInForce(status)).toBe(false);
    }
  });
});

describe('Gate-19 — fail-closed oracle re-check (takedownHaltsPublish)', () => {
  it('halts when the oracle reports a takedown', async () => {
    expect(await takedownHaltsPublish(async () => true, 'lcapb_x')).toBe(true);
  });
  it('allows when the oracle reports no takedown', async () => {
    expect(await takedownHaltsPublish(async () => false, 'lcapb_x')).toBe(false);
  });
  it('treats a throwing oracle as a halt (fail-closed)', async () => {
    expect(
      await takedownHaltsPublish(() => {
        throw new Error('db down');
      }, 'lcapb_x'),
    ).toBe(true);
  });
  it('accepts a synchronous predicate', async () => {
    expect(await takedownHaltsPublish((cid) => cid === 'lcapb_bad', 'lcapb_bad')).toBe(true);
    expect(await takedownHaltsPublish((cid) => cid === 'lcapb_bad', 'lcapb_ok')).toBe(false);
  });
});

describe('Gate-19 — republicationSet decision core', () => {
  it('excludes taken-down CIDs and keeps the rest, de-duplicating', async () => {
    const takenDown = new Set(['lcapb_b']);
    const result = await republicationSet(['lcapb_a', 'lcapb_b', 'lcapb_c', 'lcapb_a'], (cid) =>
      takenDown.has(cid),
    );
    expect(result.eligible).toEqual(['lcapb_a', 'lcapb_c']);
    expect(result.excluded).toEqual([
      { blockCid: 'lcapb_b', eligible: false, reason: 'taken_down' },
    ]);
    // De-dup: the repeated 'lcapb_a' produces one verdict, not two.
    expect(result.verdicts).toHaveLength(3);
  });

  it('excludes a CID whose oracle throws (oracle_error, fail-closed)', async () => {
    const result = await republicationSet(['lcapb_a', 'lcapb_err'], (cid) => {
      if (cid === 'lcapb_err') throw new Error('lookup failed');
      return false;
    });
    expect(result.eligible).toEqual(['lcapb_a']);
    expect(result.excluded).toEqual([
      { blockCid: 'lcapb_err', eligible: false, reason: 'oracle_error' },
    ]);
  });

  it('returns empty eligibility for an empty input', async () => {
    const result = await republicationSet([], async () => false);
    expect(result).toEqual({ eligible: [], excluded: [], verdicts: [] });
  });
});

describe('WS-S.4.4 — public-gateway eligibility guard', () => {
  const ok = {
    visibility: 'public',
    encrypted: false,
    takenDown: false,
    privateRoomCid: false,
  } as const;

  it('admits an unambiguously public, unencrypted, non-taken-down, non-private block', () => {
    expect(assertPublicGatewayEligible(ok)).toEqual({ eligible: true, reason: '' });
  });

  it('refuses a private-room CID first (strongest confidentiality signal)', () => {
    // Even with public visibility + plaintext, a private-room hint refuses.
    expect(assertPublicGatewayEligible({ ...ok, privateRoomCid: true }).reason).toBe(
      'private_room_cid',
    );
  });

  it('refuses ciphertext, non-public visibility, and an in-force takedown', () => {
    expect(assertPublicGatewayEligible({ ...ok, encrypted: true }).reason).toBe('encrypted');
    expect(assertPublicGatewayEligible({ ...ok, visibility: 'in_room' }).reason).toBe('not_public');
    expect(assertPublicGatewayEligible({ ...ok, visibility: 'private' }).reason).toBe('not_public');
    expect(assertPublicGatewayEligible({ ...ok, takenDown: true }).reason).toBe('taken_down');
  });
});

describe('Gate-19 + WS-S.4.4 — publish path defense-in-depth', () => {
  const pinningBridge = (over: Partial<ConstructorParameters<typeof IpfsBridge>[0]> = {}) => {
    let pinned = false;
    const bridge = new IpfsBridge({
      gatewayUrl: 'https://gw.test',
      pinningUrl: 'https://pin.test/add',
      fetchFn: async () => {
        pinned = true;
        return new Response(null, { status: 200 });
      },
      ...over,
    });
    return { bridge, pinned: () => pinned };
  };

  it('the publish-time oracle halts a stale `publishable:true` decision (no pin)', async () => {
    const payload = new TextEncoder().encode('stale public');
    const blockCid = await cidFor('block', payload);
    const { bridge, pinned } = pinningBridge({ takedownOracle: async () => true });
    const res = await bridge.publishBlock(
      blockCid,
      payload,
      { publishable: true, reason: '' },
      PUBLIC_GATEWAY,
    );
    expect(res).toEqual({ ok: false, reason: 'takedown_recheck_halt' });
    expect(pinned()).toBe(false);
  });

  it('a throwing oracle halts publish (fail-closed)', async () => {
    const payload = new TextEncoder().encode('oracle down');
    const blockCid = await cidFor('block', payload);
    const { bridge, pinned } = pinningBridge({
      takedownOracle: () => {
        throw new Error('db down');
      },
    });
    const res = await bridge.publishBlock(
      blockCid,
      payload,
      { publishable: true, reason: '' },
      PUBLIC_GATEWAY,
    );
    expect(res).toEqual({ ok: false, reason: 'takedown_recheck_halt' });
    expect(pinned()).toBe(false);
  });

  it('publishes when the oracle reports no takedown', async () => {
    const payload = new TextEncoder().encode('clean public');
    const blockCid = await cidFor('block', payload);
    const { bridge, pinned } = pinningBridge({ takedownOracle: async () => false });
    const res = await bridge.publishBlock(
      blockCid,
      payload,
      { publishable: true, reason: '' },
      PUBLIC_GATEWAY,
    );
    expect(res.ok).toBe(true);
    expect(pinned()).toBe(true);
  });

  it('the WS-S.4.4 guard refuses a private-room CID even with a publishable decision', async () => {
    const payload = new TextEncoder().encode('private leak attempt');
    const blockCid = await cidFor('block', payload);
    const { bridge, pinned } = pinningBridge();
    const res = await bridge.publishBlock(
      blockCid,
      payload,
      { publishable: true, reason: '' },
      { visibility: 'public', encrypted: false, takenDown: false, privateRoomCid: true },
    );
    expect(res).toEqual({ ok: false, reason: 'private_room_cid' });
    expect(pinned()).toBe(false);
  });

  it('republish REQUIRES an oracle (no_takedown_oracle without one)', async () => {
    const payload = new TextEncoder().encode('republish');
    const blockCid = await cidFor('block', payload);
    const { bridge, pinned } = pinningBridge();
    expect(await bridge.republish(blockCid, payload)).toEqual({
      ok: false,
      reason: 'no_takedown_oracle',
    });
    expect(pinned()).toBe(false);
  });

  it('republish halts a taken-down block and re-pins a clean one', async () => {
    const payload = new TextEncoder().encode('republish clean');
    const blockCid = await cidFor('block', payload);
    const halted = pinningBridge({ takedownOracle: async () => true });
    expect(await halted.bridge.republish(blockCid, payload)).toEqual({
      ok: false,
      reason: 'takedown_recheck_halt',
    });
    expect(halted.pinned()).toBe(false);
    const clean = pinningBridge({ takedownOracle: async () => false });
    const res = await clean.bridge.republish(blockCid, payload);
    expect(res.ok).toBe(true);
    expect(clean.pinned()).toBe(true);
  });
});
