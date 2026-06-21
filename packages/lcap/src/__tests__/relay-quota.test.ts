// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Relay admission quotas (§27.3, §27.4, WS-R.14.4): reserved C0/T1 capacity that
// bulk lanes cannot starve, per-peer/room/object/unverified caps, the invalid-ratio
// throttle, and the §27.4 STRUCTURAL guarantees — no client proof-of-work and no
// per-IP/network-address state (a source scan asserts the surface stays clean).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AdmissionRequest,
  admitRelayObject,
  DEFAULT_RELAY_QUOTA,
  type RelayQuotaConfig,
  type RelayUsage,
} from '../limits/relay-quota.js';

const ZERO_USAGE: RelayUsage = {
  laneUsedBytes: {},
  peerBytes: 0,
  roomBytes: 0,
  unverifiedBytes: 0,
  peerObjectsSeen: 0,
  peerObjectsInvalid: 0,
};

function usage(over: Partial<RelayUsage> = {}): RelayUsage {
  return { ...ZERO_USAGE, ...over };
}

const req = (over: Partial<AdmissionRequest> = {}): AdmissionRequest => ({
  lane: 'M3',
  sizeBytes: 1024,
  verified: true,
  ...over,
});

describe('admitRelayObject — per-object / peer / room / unverified caps', () => {
  it('admits a normal object under an empty relay', () => {
    expect(admitRelayObject(DEFAULT_RELAY_QUOTA, ZERO_USAGE, req())).toEqual({ admit: true });
  });

  it('rejects an object larger than the per-object cap', () => {
    const d = admitRelayObject(DEFAULT_RELAY_QUOTA, ZERO_USAGE, req({ sizeBytes: 1e12 }));
    expect(d).toEqual({ admit: false, reason: 'object_too_large' });
  });

  it('enforces the per-peer and per-room byte quotas at the boundary', () => {
    const cfg: RelayQuotaConfig = {
      ...DEFAULT_RELAY_QUOTA,
      perPeerBytes: 1000,
      perRoomBytes: 1000,
    };
    expect(admitRelayObject(cfg, usage({ peerBytes: 1000 }), req({ sizeBytes: 1 })).admit).toBe(
      false,
    );
    expect(admitRelayObject(cfg, usage({ peerBytes: 999 }), req({ sizeBytes: 1 })).admit).toBe(
      true,
    );
    expect(admitRelayObject(cfg, usage({ roomBytes: 1000 }), req({ sizeBytes: 1 }))).toEqual({
      admit: false,
      reason: 'room_quota',
    });
  });

  it('bounds unverified (quarantine) bytes only for unverified objects', () => {
    const cfg: RelayQuotaConfig = { ...DEFAULT_RELAY_QUOTA, maxUnverifiedBytes: 1000 };
    expect(
      admitRelayObject(
        cfg,
        usage({ unverifiedBytes: 1000 }),
        req({ verified: false, sizeBytes: 1 }),
      ),
    ).toEqual({ admit: false, reason: 'unverified_quota' });
    // A verified object is not bound by the quarantine cap.
    expect(
      admitRelayObject(cfg, usage({ unverifiedBytes: 1000 }), req({ verified: true, sizeBytes: 1 }))
        .admit,
    ).toBe(true);
  });

  it('throttles a peer over the invalid ratio, but only past the min sample', () => {
    const cfg: RelayQuotaConfig = {
      ...DEFAULT_RELAY_QUOTA,
      maxInvalidRatio: 0.5,
      invalidRatioMinSample: 10,
    };
    // 6/10 invalid > 0.5 and ≥ sample → throttled.
    expect(
      admitRelayObject(cfg, usage({ peerObjectsSeen: 10, peerObjectsInvalid: 6 }), req()),
    ).toEqual({ admit: false, reason: 'invalid_ratio' });
    // Same ratio but below the min sample → not yet throttled.
    expect(
      admitRelayObject(cfg, usage({ peerObjectsSeen: 4, peerObjectsInvalid: 3 }), req()).admit,
    ).toBe(true);
  });
});

describe('admitRelayObject — §27.3 reserved C0/T1 capacity', () => {
  // A tiny relay: total 1000, C0 reserves 100, T1 reserves 200 → general pool 700.
  const cfg: RelayQuotaConfig = {
    ...DEFAULT_RELAY_QUOTA,
    totalBytes: 1000,
    reservedFractionByLane: { C0: 0.1, T1: 0.2 },
    perPeerBytes: 1_000_000,
    perRoomBytes: 1_000_000,
    maxObjectBytes: 1_000_000,
  };

  it('lets a bulk (B4) object use the general pool but NOT the C0/T1 reserves', () => {
    // Empty relay: B4 may use 1000 − 100 − 200 = 700.
    expect(admitRelayObject(cfg, ZERO_USAGE, req({ lane: 'B4', sizeBytes: 700 })).admit).toBe(true);
    expect(admitRelayObject(cfg, ZERO_USAGE, req({ lane: 'B4', sizeBytes: 701 }))).toEqual({
      admit: false,
      reason: 'capacity',
    });
  });

  it('lets a C0 control object use ALL free space (no higher reserve)', () => {
    expect(admitRelayObject(cfg, ZERO_USAGE, req({ lane: 'C0', sizeBytes: 1000 })).admit).toBe(
      true,
    );
  });

  it('stops reserving a lane once it has filled its own reserve', () => {
    // C0 already used its full 100 reserve → B4 may now use 1000 − 100(used) − 200(T1) = 700.
    const u = usage({ laneUsedBytes: { C0: 100 } });
    expect(admitRelayObject(cfg, u, req({ lane: 'B4', sizeBytes: 700 })).admit).toBe(true);
    expect(admitRelayObject(cfg, u, req({ lane: 'B4', sizeBytes: 701 })).admit).toBe(false);
  });

  it('lets T1 encroach on everything except the C0 reserve', () => {
    // T1 may use 1000 − 100(C0 reserve) = 900 on an empty relay.
    expect(admitRelayObject(cfg, ZERO_USAGE, req({ lane: 'T1', sizeBytes: 900 })).admit).toBe(true);
    expect(admitRelayObject(cfg, ZERO_USAGE, req({ lane: 'T1', sizeBytes: 901 })).admit).toBe(
      false,
    );
  });
});

describe('§27.4 doctrine: no proof-of-work, no client network address', () => {
  it('exposes no PoW / address surface in the policy source', () => {
    const srcRoot =
      [resolve(process.cwd(), 'packages/lcap/src'), resolve(process.cwd(), 'src')].find((p) =>
        existsSync(p),
      ) ?? resolve(process.cwd(), 'src');
    const src = readFileSync(resolve(srcRoot, 'limits/relay-quota.ts'), 'utf8');
    // No proof-of-work challenge surface.
    expect(
      /proof.?of.?work|\bpow\b|difficulty|nonce|challenge/i.test(src.replace(/\/\/.*$/gm, '')),
    ).toBe(false);
    // No per-IP / network-address state (the §19.1 identity-free posture).
    expect(
      /\bip(v4|v6|addr|address)?\b|remoteAddr|x-forwarded|geoip|\bgeo\b/i.test(
        src.replace(/\/\/.*$/gm, ''),
      ),
    ).toBe(false);
  });
});
