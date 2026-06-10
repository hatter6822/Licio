// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The single "at least one auth method" invariant (WS-D.1.2c).  Every removal
// path — delete a passkey, disable email, unlink an auth-wallet — consults this
// so an account can never be left with zero ways to sign in (a safety property,
// never a security weakening: it only prevents an unrecoverable lockout).
//
// "Auth methods" counts active passkeys + a verified email (email-OTP capability)
// + linked auth-wallets.  Email is one method regardless of how many addresses; a
// passkey or wallet counts per credential.

export type AuthMethodKind = 'passkey' | 'email' | 'wallet';

export interface AuthMethodInventory {
  /** Count of active WebAuthn credentials. */
  passkeys: number;
  /** Whether a verified email factor exists (email-OTP capability). */
  emailVerified: boolean;
  /** Count of linked auth-wallets. */
  authWallets: number;
}

/** Total number of distinct ways the account can currently authenticate. */
export function countAuthMethods(inv: AuthMethodInventory): number {
  return inv.passkeys + (inv.emailVerified ? 1 : 0) + inv.authWallets;
}

/** The inventory that would result from removing one unit of `kind`. */
export function inventoryAfterRemoval(
  inv: AuthMethodInventory,
  kind: AuthMethodKind,
): AuthMethodInventory {
  switch (kind) {
    case 'passkey':
      return { ...inv, passkeys: Math.max(0, inv.passkeys - 1) };
    case 'wallet':
      return { ...inv, authWallets: Math.max(0, inv.authWallets - 1) };
    case 'email':
      return { ...inv, emailVerified: false };
  }
}

/**
 * Whether removing one unit of `kind` would leave the account with zero auth
 * methods.  The removal endpoints refuse when this is true ("set up another way
 * to sign in first").
 */
export function isLastMethodRemoval(inv: AuthMethodInventory, kind: AuthMethodKind): boolean {
  return countAuthMethods(inventoryAfterRemoval(inv, kind)) < 1;
}

/**
 * Whether the account currently holds ANY verified credential — used by
 * `requireVerifiedAccount` (WS-D.1.6a).  A passkey or auth-wallet inherently
 * proves control at registration; a verified email also qualifies.  Only an
 * email-registration whose code is unconfirmed (no passkey/wallet, email not yet
 * verified) is unverified.
 */
export function hasVerifiedCredential(inv: AuthMethodInventory): boolean {
  return inv.passkeys > 0 || inv.authWallets > 0 || inv.emailVerified;
}
