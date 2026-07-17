// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.2b — the stable review key for a DIRECT (intent-less) high-value
// transfer.  Keying by the per-attempt `typedDataHash` re-blocked every retry
// after a clearance (the hash binds the nonce/expiration a retry must change);
// this key identifies the MOVEMENT so the retry honors the clearance.
import { describe, expect, it } from 'vitest';
import { directTransferReviewRef } from '../knomosis/compliance-mapping.js';

describe('directTransferReviewRef', () => {
  const base: Record<string, unknown> = {
    actor: '0xabc0000000000000000000000000000000000001',
    amount: '1000000',
    asset: 'USDC',
    grantId: 'grant-1',
    recipient: '0xdef0000000000000000000000000000000000002',
    nonce: '7',
    expiration: '1799999999',
  };
  const key = (m: Record<string, unknown>) =>
    directTransferReviewRef('grant_payout', 'dep-1', 'room-1', m);

  it('is STABLE across the per-attempt nonce and expiration (retry honors clearance)', () => {
    // The exact retry the finding is about: the reviewer clears after the payload
    // expired, so the user re-signs with a fresh nonce + expiration.
    expect(key({ ...base, nonce: '99', expiration: '1800000123' })).toBe(key(base));
  });

  it('normalizes actor/recipient case — a re-sign with a checksummed address matches', () => {
    expect(
      key({
        ...base,
        actor: (base['actor'] as string).toUpperCase(),
        recipient: (base['recipient'] as string).toUpperCase(),
      }),
    ).toBe(key(base));
  });

  it('DIFFERS for any different movement field (so distinct transfers get distinct reviews)', () => {
    const k0 = key(base);
    expect(key({ ...base, amount: '2000000' })).not.toBe(k0);
    expect(key({ ...base, asset: 'DAI' })).not.toBe(k0);
    expect(key({ ...base, grantId: 'grant-2' })).not.toBe(k0); // the target
    expect(key({ ...base, recipient: `0x${'9'.repeat(40)}` })).not.toBe(k0);
    expect(key({ ...base, actor: `0x${'8'.repeat(40)}` })).not.toBe(k0);
    expect(directTransferReviewRef('grant_payout', 'dep-1', 'room-2', base)).not.toBe(k0); // room
    expect(directTransferReviewRef('grant_payout', 'dep-2', 'room-1', base)).not.toBe(k0); // deployment
    expect(directTransferReviewRef('treasury_deposit', 'dep-1', 'room-1', base)).not.toBe(k0); // action
  });

  it('reads the TARGET field per action type (grantId for a payout, treasuryId for a deposit)', () => {
    // Two deposits differing only by treasury get distinct keys; grantId is ignored
    // for a deposit (its target field is treasuryId).
    const d = (treasuryId: string) =>
      directTransferReviewRef('treasury_deposit', 'dep-1', 'room-1', {
        ...base,
        treasuryId,
      });
    expect(d('t-1')).not.toBe(d('t-2'));
  });
});
