// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  type AuthMethodInventory,
  countAuthMethods,
  hasVerifiedCredential,
  inventoryAfterRemoval,
  isLastMethodRemoval,
} from '../auth-methods.js';

describe('countAuthMethods', () => {
  it('counts passkeys + verified email + auth-wallets', () => {
    expect(countAuthMethods({ passkeys: 2, emailVerified: true, authWallets: 1 })).toBe(4);
    expect(countAuthMethods({ passkeys: 0, emailVerified: false, authWallets: 0 })).toBe(0);
    expect(countAuthMethods({ passkeys: 0, emailVerified: true, authWallets: 0 })).toBe(1);
  });
});

describe('isLastMethodRemoval', () => {
  it('blocks removing the only passkey on a passkey-only account', () => {
    const inv: AuthMethodInventory = { passkeys: 1, emailVerified: false, authWallets: 0 };
    expect(isLastMethodRemoval(inv, 'passkey')).toBe(true);
  });

  it('allows removing a passkey when a verified email remains', () => {
    const inv: AuthMethodInventory = { passkeys: 1, emailVerified: true, authWallets: 0 };
    expect(isLastMethodRemoval(inv, 'passkey')).toBe(false);
  });

  it('blocks disabling email on an email-only account', () => {
    const inv: AuthMethodInventory = { passkeys: 0, emailVerified: true, authWallets: 0 };
    expect(isLastMethodRemoval(inv, 'email')).toBe(true);
  });

  it('blocks unlinking the only auth-wallet on a wallet-only account', () => {
    const inv: AuthMethodInventory = { passkeys: 0, emailVerified: false, authWallets: 1 };
    expect(isLastMethodRemoval(inv, 'wallet')).toBe(true);
  });

  it('allows removing one of two passkeys', () => {
    const inv: AuthMethodInventory = { passkeys: 2, emailVerified: false, authWallets: 0 };
    expect(isLastMethodRemoval(inv, 'passkey')).toBe(false);
  });
});

describe('inventoryAfterRemoval', () => {
  it('decrements the right counter and never goes negative', () => {
    expect(
      inventoryAfterRemoval({ passkeys: 0, emailVerified: false, authWallets: 0 }, 'passkey'),
    ).toEqual({
      passkeys: 0,
      emailVerified: false,
      authWallets: 0,
    });
    expect(
      inventoryAfterRemoval({ passkeys: 1, emailVerified: true, authWallets: 2 }, 'email'),
    ).toEqual({
      passkeys: 1,
      emailVerified: false,
      authWallets: 2,
    });
  });
});

describe('hasVerifiedCredential', () => {
  it('is true for any passkey/wallet, or a verified email; false only for unconfirmed email-only', () => {
    expect(hasVerifiedCredential({ passkeys: 1, emailVerified: false, authWallets: 0 })).toBe(true);
    expect(hasVerifiedCredential({ passkeys: 0, emailVerified: false, authWallets: 1 })).toBe(true);
    expect(hasVerifiedCredential({ passkeys: 0, emailVerified: true, authWallets: 0 })).toBe(true);
    expect(hasVerifiedCredential({ passkeys: 0, emailVerified: false, authWallets: 0 })).toBe(
      false,
    );
  });
});
