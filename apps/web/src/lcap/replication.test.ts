// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.5 — the §21.4 replication-eligibility matrix: public opportunistic, in-room
// by room policy, private default-deny unless encrypted + permitted + user-selected,
// and the transfer policy gating every decision.
import { describe, expect, it } from 'vitest';
import {
  mayReplicate,
  type ReplicationRequest,
  replicationDecision,
  type TransferPolicy,
} from './replication.js';

const ALLOW_ALL: TransferPolicy = {
  mayExportBundle: true,
  mayShareWithRelay: true,
  mayShareWithCourier: true,
  mayShareWithUnknownPeer: true,
};
const DENY_ALL: TransferPolicy = {
  mayExportBundle: false,
  mayShareWithRelay: false,
  mayShareWithCourier: false,
  mayShareWithUnknownPeer: false,
};

function req(over: Partial<ReplicationRequest> = {}): ReplicationRequest {
  return {
    visibility: 'public',
    encrypted: false,
    transferPolicy: ALLOW_ALL,
    roomPolicyPermits: true,
    userSelected: false,
    channel: 'relay',
    ...over,
  };
}

describe('public content', () => {
  it('replicates opportunistically when the transfer policy allows', () => {
    expect(mayReplicate(req({ visibility: 'public' }))).toBe(true);
  });
  it('is still gated by the transfer policy', () => {
    expect(mayReplicate(req({ visibility: 'public', transferPolicy: DENY_ALL }))).toBe(false);
  });
});

describe('in-room content', () => {
  it('follows room policy', () => {
    expect(mayReplicate(req({ visibility: 'in_room', roomPolicyPermits: true }))).toBe(true);
    expect(mayReplicate(req({ visibility: 'in_room', roomPolicyPermits: false }))).toBe(false);
  });
});

describe('private-room content (default-deny)', () => {
  it('refuses plaintext outright', () => {
    const d = replicationDecision(
      req({ visibility: 'private', encrypted: false, roomPolicyPermits: true, userSelected: true }),
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('private_plaintext_forbidden');
  });

  it('refuses encrypted content that the user did not select', () => {
    expect(
      mayReplicate(
        req({
          visibility: 'private',
          encrypted: true,
          roomPolicyPermits: true,
          userSelected: false,
        }),
      ),
    ).toBe(false);
  });

  it('refuses encrypted, selected content the room policy forbids', () => {
    expect(
      mayReplicate(
        req({
          visibility: 'private',
          encrypted: true,
          roomPolicyPermits: false,
          userSelected: true,
        }),
      ),
    ).toBe(false);
  });

  it('allows ONLY encrypted + room-permitted + user-selected, flagging metadata risk', () => {
    const d = replicationDecision(
      req({
        visibility: 'private',
        encrypted: true,
        roomPolicyPermits: true,
        userSelected: true,
        channel: 'courier',
      }),
    );
    expect(d.allowed).toBe(true);
    expect(d.metadataRisk).toBe(true); // size/timing/room-access still leak (§21.4)
  });

  it('still defers to the transfer policy even when everything else permits', () => {
    expect(
      mayReplicate(
        req({
          visibility: 'private',
          encrypted: true,
          roomPolicyPermits: true,
          userSelected: true,
          transferPolicy: DENY_ALL,
        }),
      ),
    ).toBe(false);
  });
});

describe('default-deny + channel mapping', () => {
  it('denies an unknown visibility', () => {
    const d = replicationDecision(req({ visibility: 'mystery' }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('unknown_visibility_default_deny');
  });

  it('maps each channel to its transfer-policy field', () => {
    const onlyExport: TransferPolicy = { ...DENY_ALL, mayExportBundle: true };
    expect(mayReplicate(req({ channel: 'export', transferPolicy: onlyExport }))).toBe(true);
    expect(mayReplicate(req({ channel: 'relay', transferPolicy: onlyExport }))).toBe(false);

    const onlyCourier: TransferPolicy = { ...DENY_ALL, mayShareWithCourier: true };
    expect(mayReplicate(req({ channel: 'courier', transferPolicy: onlyCourier }))).toBe(true);
    expect(mayReplicate(req({ channel: 'advertise', transferPolicy: onlyCourier }))).toBe(true);
    expect(mayReplicate(req({ channel: 'peer', transferPolicy: onlyCourier }))).toBe(false);
  });
});
