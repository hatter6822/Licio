// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sign-In with Ethereum (EIP-4361 / SIWE) — the adult-only, opt-in passwordless
// fallback (WS-D.1.4c).  Cryptographic verification is delegated to viem (never
// home-grown): EOA signatures via `recoverMessageAddress` (EIP-191), and contract
// wallets / counterfactual smart accounts (EIP-1271 / EIP-6492) via an injected
// on-chain verifier (a viem public client in production, mockable in tests).
//
// The anti-phishing backbone is the `domain`/`uri` binding to Licio's canonical
// origin (the SIWE analogue of the WebAuthn RP-ID): a signature minted for a
// look-alike domain will not validate here (§25.5).  Nonces are single-use,
// TTL-bounded, and browser-bound via the `login_attempt_id`.
//
// The verified address is hashed under the AUTH-domain HMAC key — domain-separated
// from the financial-wallet key — so signing in with a wallet can never be
// correlated with a financial WalletAccount (§19.5).
import { createPublicClient, http, recoverMessageAddress } from 'viem';
import { generateSiweNonce, parseSiweMessage } from 'viem/siwe';
import { deriveKey, hmacHex, KEY_DOMAINS, truncateAddress } from './crypto.js';
import type { EphemeralStore } from './ephemeral-store.js';

export interface SiweConfig {
  /** Canonical host the message `domain` must equal (e.g. "licio.app"). */
  domain: string;
  /** Canonical origin the message `uri` must equal (e.g. "https://licio.app"). */
  uri: string;
  /** Permitted chain ids. */
  chainAllowlist: readonly number[];
  /**
   * Optional per-chain JSON-RPC endpoints.  When a chain has an endpoint, contract
   * wallets (EIP-1271) and counterfactual smart accounts (EIP-6492) can be verified
   * on-chain; without one, only EOA (EIP-191) sign-in works for that chain.
   */
  chainRpcUrls?: Readonly<Record<number, string>>;
  nonceTtlMs?: number;
  maxClockSkewMs?: number;
}

export const SIWE_NONCE_TTL_MS = 5 * 60_000;
const SKEW_DEFAULT_MS = 2 * 60_000;

const nonceKey = (attemptId: string): string => `authsiwe:nonce:${attemptId}`;

export interface SiweNonce {
  nonce: string;
  issuedAt: string;
}

/** Issue a single-use SIWE nonce bound to the initiating browser's attempt id. */
export async function issueSiweNonce(
  store: EphemeralStore,
  attemptId: string,
  config: Pick<SiweConfig, 'nonceTtlMs'> = {},
  now: number = Date.now(),
): Promise<SiweNonce> {
  const nonce = generateSiweNonce();
  await store.set(nonceKey(attemptId), nonce, config.nonceTtlMs ?? SIWE_NONCE_TTL_MS);
  return { nonce, issuedAt: new Date(now).toISOString() };
}

export type SiweFailureReason =
  | 'malformed'
  | 'nonce_invalid'
  | 'domain_mismatch'
  | 'uri_mismatch'
  | 'chain_not_allowed'
  | 'expired'
  | 'not_yet_valid'
  | 'signature_invalid';

export interface SiweSuccess {
  ok: true;
  address: string;
  addressLower: string;
  addressTruncated: string;
  chainId: number;
  walletType: 'eoa' | 'contract';
}
export interface SiweError {
  ok: false;
  reason: SiweFailureReason;
}
export type SiweResult = SiweSuccess | SiweError;

export type ContractSignatureVerifier = (args: {
  address: string;
  message: string;
  signature: `0x${string}`;
  chainId: number;
}) => Promise<boolean>;

export interface ParsedSiweFields {
  address: string;
  domain: string;
  uri: string;
  nonce: string;
  chainId: number;
  issuedAt?: Date;
  expirationTime?: Date;
  notBefore?: Date;
}

/**
 * Validate the EIP-4361 message fields against the canonical-origin binding, chain
 * allowlist, and time bounds.  Pure (no signature, no I/O) and exhaustively
 * testable.  Returns the parsed fields or a typed failure reason.
 */
export function validateSiweFields(
  message: string,
  config: SiweConfig,
  now: number = Date.now(),
): { ok: true; fields: ParsedSiweFields } | SiweError {
  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(message);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const { address, domain, uri, nonce, chainId } = parsed;
  if (!address || !domain || !uri || !nonce || typeof chainId !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (domain !== config.domain) return { ok: false, reason: 'domain_mismatch' };
  if (uri !== config.uri) return { ok: false, reason: 'uri_mismatch' };
  if (!config.chainAllowlist.includes(chainId)) return { ok: false, reason: 'chain_not_allowed' };

  const skew = config.maxClockSkewMs ?? SKEW_DEFAULT_MS;
  if (parsed.issuedAt && parsed.issuedAt.getTime() > now + skew) {
    return { ok: false, reason: 'not_yet_valid' };
  }
  if (parsed.notBefore && parsed.notBefore.getTime() > now) {
    return { ok: false, reason: 'not_yet_valid' };
  }
  if (parsed.expirationTime && parsed.expirationTime.getTime() <= now) {
    return { ok: false, reason: 'expired' };
  }
  return {
    ok: true,
    fields: {
      address,
      domain,
      uri,
      nonce,
      chainId,
      ...(parsed.issuedAt ? { issuedAt: parsed.issuedAt } : {}),
      ...(parsed.expirationTime ? { expirationTime: parsed.expirationTime } : {}),
      ...(parsed.notBefore ? { notBefore: parsed.notBefore } : {}),
    },
  };
}

export interface VerifySiweInput {
  store: EphemeralStore;
  attemptId: string;
  message: string;
  signature: string;
  config: SiweConfig;
  now?: number;
  /** On-chain verifier for EIP-1271/6492 (smart-contract / counterfactual wallets). */
  contractVerifier?: ContractSignatureVerifier;
}

/**
 * Full SIWE verification: consume the single-use nonce, validate the canonical
 * binding + chain + time, then verify the signature (EOA via viem recover, else
 * the injected contract verifier).  Returns the verified address + wallet type or
 * a typed failure.  The nonce is consumed on EVERY call so a replay always fails.
 */
export async function verifySiwe(input: VerifySiweInput): Promise<SiweResult> {
  const now = input.now ?? Date.now();

  const validated = validateSiweFields(input.message, input.config, now);

  // Consume the single-use nonce on EVERY attempt (a malformed OR replayed
  // message burns it too), BEFORE any early return — otherwise a malformed
  // message leaves the nonce live for retry, contradicting the single-use
  // contract. The stored nonce is keyed by attemptId, so it can be taken even
  // when the message itself did not parse.
  const storedNonce = await input.store.take(nonceKey(input.attemptId));
  if (!validated.ok) return validated;
  if (!storedNonce || storedNonce !== validated.fields.nonce) {
    return { ok: false, reason: 'nonce_invalid' };
  }

  const { fields } = validated;
  const signature = input.signature as `0x${string}`;

  let walletType: 'eoa' | 'contract' = 'eoa';
  let verified = false;
  try {
    const recovered = await recoverMessageAddress({ message: input.message, signature });
    verified = recovered.toLowerCase() === fields.address.toLowerCase();
  } catch {
    verified = false;
  }
  if (!verified && input.contractVerifier) {
    walletType = 'contract';
    verified = await input.contractVerifier({
      address: fields.address,
      message: input.message,
      signature,
      chainId: fields.chainId,
    });
  }
  if (!verified) return { ok: false, reason: 'signature_invalid' };

  return {
    ok: true,
    address: fields.address,
    addressLower: fields.address.toLowerCase(),
    addressTruncated: truncateAddress(fields.address),
    chainId: fields.chainId,
    walletType,
  };
}

/**
 * Hash a verified auth-wallet address under the AUTH-domain key.  Domain-separated
 * from {@link hashFinancialWalletAddress} so the same address yields different,
 * non-correlatable hashes in the identity vs. financial contexts (§19.5).
 */
export function hashAuthWalletAddress(masterSecret: string, addressLower: string): string {
  return hmacHex(deriveKey(masterSecret, KEY_DOMAINS.authWallet), addressLower);
}

/** Hash a financial-wallet address under the FINANCIAL-domain key (WS-D.3 / WS-L). */
export function hashFinancialWalletAddress(masterSecret: string, addressLower: string): string {
  return hmacHex(deriveKey(masterSecret, KEY_DOMAINS.financialWallet), addressLower);
}

/**
 * Build the on-chain contract-signature verifier (EIP-1271 / EIP-6492) from the
 * configured per-chain RPC endpoints, using viem's `publicClient.verifyMessage`
 * (which transparently handles deployed contract wallets and counterfactual smart
 * accounts).  Returns `undefined` when no RPC is configured — then only EOA
 * sign-in works.  A chain with no endpoint, or any RPC error, verifies as false.
 */
export function createContractVerifier(
  chainRpcUrls: Readonly<Record<number, string>> = {},
): ContractSignatureVerifier | undefined {
  if (Object.keys(chainRpcUrls).length === 0) return undefined;
  return async ({ address, message, signature, chainId }) => {
    const rpc = chainRpcUrls[chainId];
    if (!rpc) return false;
    try {
      const client = createPublicClient({ transport: http(rpc) });
      return await client.verifyMessage({ address: address as `0x${string}`, message, signature });
    } catch {
      return false;
    }
  };
}
