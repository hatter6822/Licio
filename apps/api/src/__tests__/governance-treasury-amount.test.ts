// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U / WS-L — the treasury-amount canonicalization that keeps the in-memory
// and the Drizzle (Postgres `numeric` ⇒ string) TreasuryActionStore adapters
// behaviourally symmetric: a value reads back as a lossless `number` when it
// round-trips through IEEE-754, otherwise as its exact decimal string (so a
// minor-unit / uint256 amount is never silently rounded).  This is the ungated
// mirror of the gated `governance-integration` Postgres assertion.

import { describe, expect, it } from 'vitest';
import {
  canonicalTreasuryAmount,
  InMemoryTreasuryActionStore,
  type TreasuryActionRecord,
} from '../governance/stores.js';

describe('canonicalTreasuryAmount', () => {
  it('returns a lossless small integer as a number (either input type)', () => {
    expect(canonicalTreasuryAmount(10)).toBe(10);
    expect(canonicalTreasuryAmount('10')).toBe(10);
    expect(canonicalTreasuryAmount(0)).toBe(0);
    expect(canonicalTreasuryAmount('0')).toBe(0);
    expect(canonicalTreasuryAmount('5')).toBe(5);
  });

  it('returns a lossless decimal as a number but preserves non-round-trip scale', () => {
    expect(canonicalTreasuryAmount('10.5')).toBe(10.5);
    // A trailing zero would be lost by Number(); keep the exact string.
    expect(canonicalTreasuryAmount('10.50')).toBe('10.50');
    expect(canonicalTreasuryAmount('10.0')).toBe('10.0');
  });

  it('keeps a precision-losing minor-unit amount as an exact string', () => {
    // The criterion is FAITHFULNESS, not magnitude: a value that does not
    // round-trip through a double stays an exact string.
    expect(canonicalTreasuryAmount('9007199254740993')).toBe('9007199254740993'); // 2^53 + 1
    expect(canonicalTreasuryAmount('1000000000000000001')).toBe('1000000000000000001'); // 10^18 + 1
    const huge = '123456789012345678901234567890';
    expect(canonicalTreasuryAmount(huge)).toBe(huge);
  });

  it('returns an EXACTLY-representable large integer as a number (faithful, not lossy)', () => {
    // 10^18 (1 ETH in wei) exceeds 2^53 yet is a product of powers of 2 and 5, so
    // it is representable exactly; the number is a lossless stand-in and decimal.ts
    // renders it back identically, so returning the number is correct.
    expect(canonicalTreasuryAmount('1000000000000000000')).toBe(1e18);
  });

  it('never emits exponent notation (a decimal-string value stays a string)', () => {
    // Number("1e21") would round-trip through String() as "1e+21" ≠ the stored
    // plain decimal, so the exact string is preserved (kernel-safe for decimal.ts).
    const big = '1000000000000000000000'; // 1e21 written plainly
    expect(canonicalTreasuryAmount(big)).toBe(big);
  });
});

function record(amount: number | string, accepted = true): TreasuryActionRecord {
  return {
    actionId: `a-${amount}-${accepted}`,
    roomId: 'r1',
    category: 'grant',
    amount,
    asset: null,
    targetAllocation: null,
    accepted,
    verdict: accepted
      ? { accepted: true, evidence: { checks: [] } }
      : { accepted: false, code: 'crypto_disabled', reason: 'disabled' },
    executedAt: '2026-07-07T00:00:00.000Z',
  };
}

describe('InMemoryTreasuryActionStore.acceptedByRoom canonicalizes amounts', () => {
  it('reads a number-input amount back as the identical number', async () => {
    const store = new InMemoryTreasuryActionStore();
    await store.append(record(10));
    const rows = await store.acceptedByRoom('r1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(10);
  });

  it('reads a string-input small amount back as a number (adapter symmetry)', async () => {
    const store = new InMemoryTreasuryActionStore();
    await store.append(record('10'));
    const rows = await store.acceptedByRoom('r1');
    expect(rows[0]?.amount).toBe(10);
  });

  it('preserves a precision-losing minor-unit string amount exactly and filters rejected rows', async () => {
    const store = new InMemoryTreasuryActionStore();
    await store.append(record('1000000000000000001')); // 10^18 + 1 (not representable)
    await store.append(record(5, false));
    const rows = await store.acceptedByRoom('r1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe('1000000000000000001');
  });
});
