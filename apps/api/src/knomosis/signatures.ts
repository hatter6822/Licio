// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.4a/b/c — EIP-712 typed-data validation + signature verification.
// Cryptographic verification is delegated to viem (never home-grown): the
// digest is `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct)` via
// `hashTypedData`, EOA signatures verify via `recoverTypedDataAddress`
// (ecrecover), and contract wallets / counterfactual smart accounts
// (EIP-1271 / EIP-6492) verify via an injected on-chain verifier (a viem
// public client in production, mockable in tests).
//
// Malleability (WS-L.2.4a): secp256k1 signatures have a (r, s) twin with
// s' = n − s; Ethereum's bare ecrecover accepts both.  We enforce LOW-s
// explicitly — a 65-byte signature with s > n/2 is rejected before any
// recovery — so a captured signature cannot be replayed in its malleable
// twin form.  `v` values 27/28 and yParity 0/1 are both accepted (viem
// normalizes).  EIP-1271 signatures (arbitrary bytes for multisigs) are
// exempt from the 65-byte parse, but only reach the contract path after the
// EOA path has failed.

import {
  buildTypedDataPayload,
  type KnomosisEip712Domain,
  type KnomosisSignedActionType,
} from '@licio/shared';
import {
  createPublicClient,
  hashTypedData,
  hexToBigInt,
  http,
  parseSignature,
  recoverAddress,
} from 'viem';

/** secp256k1 group order n and its half (low-s boundary). */
const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

export type SignatureFailureReason =
  | 'message_invalid'
  | 'signature_malformed'
  | 'signature_malleable'
  | 'signature_invalid';

export type ActionSignatureResult =
  | {
      ok: true;
      walletType: 'eoa' | 'contract';
      /** The 0x-prefixed EIP-712 digest that was signed. */
      typedDataHash: `0x${string}`;
      /** The claimed (and now verified) signer address, lowercased. */
      actorLower: string;
    }
  | { ok: false; reason: SignatureFailureReason };

/**
 * Enforce low-s on a 65-byte ECDSA signature.  Returns:
 *  - 'ok'         — parseable and s ≤ n/2
 *  - 'malleable'  — parseable but s > n/2 (the malleable twin; reject)
 *  - 'not_ecdsa'  — not a parseable 65-byte signature (candidate EIP-1271 blob)
 */
export function classifyEcdsaSignature(signature: string): 'ok' | 'malleable' | 'not_ecdsa' {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return 'not_ecdsa';
  try {
    const parsed = parseSignature(signature as `0x${string}`);
    return hexToBigInt(parsed.s) > SECP256K1_HALF_N ? 'malleable' : 'ok';
  } catch {
    return 'not_ecdsa';
  }
}

/** On-chain EIP-1271/6492 verifier seam (viem public client in production). */
export type ContractTypedDataVerifier = (args: {
  address: string;
  typedDataHash: `0x${string}`;
  signature: `0x${string}`;
  chainId: number;
}) => Promise<boolean>;

/**
 * Build the production contract verifier from per-chain RPC endpoints, using
 * viem's `publicClient.verifyHash` (ERC-6492-aware: handles deployed contract
 * wallets via EIP-1271 `isValidSignature` over read-only `eth_call`, and
 * counterfactual smart accounts via the deployless wrapper).  A chain with no
 * endpoint, or any RPC error, verifies as FALSE (fail closed) — never a throw.
 */
export function createContractTypedDataVerifier(
  chainRpcUrls: Readonly<Record<number, string>> = {},
): ContractTypedDataVerifier | undefined {
  if (Object.keys(chainRpcUrls).length === 0) return undefined;
  return async ({ address, typedDataHash, signature, chainId }) => {
    const rpc = chainRpcUrls[chainId];
    if (!rpc) return false;
    try {
      const client = createPublicClient({ transport: http(rpc) });
      return await client.verifyHash({
        address: address as `0x${string}`,
        hash: typedDataHash,
        signature,
      });
    } catch {
      return false;
    }
  };
}

/**
 * Compute the EIP-712 digest for a registered action.  Throws on an
 * unregistered action type or a message failing its strict schema —
 * callers treat a throw as `message_invalid` (fail closed).
 */
export function computeTypedDataDigest(
  actionType: KnomosisSignedActionType,
  domain: KnomosisEip712Domain,
  message: Record<string, string>,
): `0x${string}` {
  const payload = buildTypedDataPayload(actionType, domain, message);
  return hashTypedData({
    domain: {
      name: payload.domain.name,
      version: payload.domain.version,
      chainId: payload.domain.chainId,
      verifyingContract: payload.domain.verifyingContract as `0x${string}`,
    },
    // viem derives the EIP712Domain type itself; pass only the message types.
    types: { [payload.primaryType]: payload.types[payload.primaryType] ?? [] },
    primaryType: payload.primaryType,
    message: payload.message,
  });
}

export interface VerifyActionSignatureInput {
  actionType: KnomosisSignedActionType;
  domain: KnomosisEip712Domain;
  message: Record<string, string>;
  signature: string;
  /** Injected EIP-1271/6492 verifier; absent ⇒ only EOA signatures verify. */
  contractVerifier?: ContractTypedDataVerifier | undefined;
}

/**
 * Full signature verification for a registered signed action (WS-L.2.4a/b/c):
 * validate the message against the shared struct registry, compute the
 * `0x1901` digest, enforce low-s, then verify EOA (ecrecover) or contract
 * (EIP-1271) against the message's own `actor` field.  The caller separately
 * proves the actor is the authenticated user's linked wallet by comparing the
 * financial-domain HMAC of `actorLower` to the stored `address_hash`.
 */
export async function verifyActionSignature(
  input: VerifyActionSignatureInput,
): Promise<ActionSignatureResult> {
  let typedDataHash: `0x${string}`;
  let actor: string;
  try {
    typedDataHash = computeTypedDataDigest(input.actionType, input.domain, input.message);
    const claimed = input.message['actor'];
    if (claimed === undefined) return { ok: false, reason: 'message_invalid' };
    actor = claimed;
  } catch {
    return { ok: false, reason: 'message_invalid' };
  }

  if (!/^0x[0-9a-fA-F]{130,4096}$/.test(input.signature)) {
    return { ok: false, reason: 'signature_malformed' };
  }
  const signature = input.signature as `0x${string}`;
  const actorLower = actor.toLowerCase();

  const ecdsaClass = classifyEcdsaSignature(signature);
  if (ecdsaClass === 'malleable') return { ok: false, reason: 'signature_malleable' };

  if (ecdsaClass === 'ok') {
    try {
      const recovered = await recoverAddress({ hash: typedDataHash, signature });
      if (recovered.toLowerCase() === actorLower) {
        return { ok: true, walletType: 'eoa', typedDataHash, actorLower };
      }
    } catch {
      // fall through to the contract path
    }
  }

  if (input.contractVerifier) {
    const valid = await input.contractVerifier({
      address: actor,
      typedDataHash,
      signature,
      chainId: input.domain.chainId,
    });
    if (valid) return { ok: true, walletType: 'contract', typedDataHash, actorLower };
  }

  return { ok: false, reason: 'signature_invalid' };
}
