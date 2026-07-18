// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.2.3b — browser EIP-712 signing over the SHARED typed-data registry
// (`@licio/shared` `buildTypedDataPayload`): the client builds the exact
// payload the server verifies, shows the WS-L.2.6 full-disclosure preview
// derived from it, and signs via `eth_signTypedData_v4` on an EIP-6963
// discovered provider.  No parallel message definition exists — a divergent
// shape is a zod failure here before the wallet ever opens.

import {
  buildTypedDataPayload,
  type KnomosisEip712Domain,
  type KnomosisSignedActionType,
} from '@licio/shared';
import { startProviderDiscovery } from '../wallet/discovery.js';
import type { Eip1193Provider, Eip6963ProviderDetail } from '../wallet/eip1193.js';

/** How long a signature stays valid (unix-seconds expiration in the message). */
const SIGNATURE_TTL_SECONDS = 10 * 60;

/** A fresh 128-bit anti-replay nonce as a canonical uint256 decimal string. */
export function freshNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value.toString(10);
}

/** Signature expiration `SIGNATURE_TTL_SECONDS` from now (unix seconds). */
export function signatureExpiration(nowMs: number = Date.now()): string {
  return String(Math.floor(nowMs / 1000) + SIGNATURE_TTL_SECONDS);
}

/** Wait briefly for EIP-6963 provider announcements; empty when none installed. */
export function discoverProviders(timeoutMs = 300): Promise<readonly Eip6963ProviderDetail[]> {
  return new Promise((resolve) => {
    let latest: readonly Eip6963ProviderDetail[] = [];
    const stop = startProviderDiscovery((providers) => {
      latest = providers;
    });
    setTimeout(() => {
      stop();
      resolve(latest);
    }, timeoutMs);
  });
}

/** Ask a provider for its selected account (EIP-1193); null on rejection. */
export async function requestAccount(provider: Eip1193Provider): Promise<string | null> {
  try {
    const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as unknown;
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') return null;
    return accounts[0].toLowerCase();
  } catch {
    return null;
  }
}

export interface SignTypedDataInput {
  provider: Eip1193Provider;
  /** The signing account (lowercased 0x address from {@link requestAccount}). */
  address: string;
  actionType: KnomosisSignedActionType;
  domain: KnomosisEip712Domain;
  /** The message WITHOUT its binding quartet is invalid — callers pass the
   *  complete registry-shaped message including actor/nonce/expiration/
   *  deploymentId; `buildTypedDataPayload` rejects anything else. */
  message: Record<string, string>;
}

export interface SignTypedDataResult {
  signature: string;
  message: Record<string, string>;
}

/**
 * Build the registry payload and sign it with `eth_signTypedData_v4`.
 * Throws on schema mismatch (fail-closed before the wallet opens); returns
 * null when the wallet rejects or returns a malformed signature.
 */
export async function signTypedData(
  input: SignTypedDataInput,
): Promise<SignTypedDataResult | null> {
  const payload = buildTypedDataPayload(input.actionType, input.domain, input.message);
  try {
    const signature = (await input.provider.request({
      method: 'eth_signTypedData_v4',
      params: [input.address, JSON.stringify(payload)],
    })) as unknown;
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,4096}$/.test(signature)) {
      return null;
    }
    return { signature, message: payload.message };
  } catch {
    return null;
  }
}
