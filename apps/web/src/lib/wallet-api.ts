// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2 wallet + knomosis BFF client.  Every response is zod-validated
// through `parseResponse` before it can reach the TanStack Query cache
// (data-fetching ABSOLUTE).  Mirrors the lib/governance-api.ts shape: import
// the typed `client` + `parseResponse` from ./api.js, one thin function per
// endpoint.  The wallet surface is intentionally small — wallet entry points
// are rare (SPEC §17.8).

import {
  type ComprehensionQuizResponse,
  type ComprehensionSubmitResponse,
  comprehensionQuizResponseSchema,
  comprehensionSubmitResponseSchema,
  type GovernanceProposalListResponse,
  type GovernanceTabResponse,
  governanceProposalListResponseSchema,
  governanceTabResponseSchema,
  type KnomosisManifestResponse,
  knomosisManifestResponseSchema,
  type RoomReadinessResponse,
  roomReadinessResponseSchema,
  type WalletLinkResponse,
  type WalletListResponse,
  type WalletNonceResponse,
  type WalletRiskStateResponse,
  walletLinkResponseSchema,
  walletListResponseSchema,
  walletNonceResponseSchema,
  walletRiskStateResponseSchema,
} from '@licio/shared';
import { z } from 'zod';
import { client, parseResponse } from './api.js';
import { parseWithStepUp } from './auth-api.js';

// --- Wallet link lifecycle (WS-L.2) ----------------------------------------

export async function requestWalletNonce(): Promise<WalletNonceResponse> {
  const response = await client.v1.wallet.nonce.$post();
  return parseResponse(response, walletNonceResponseSchema);
}

export async function linkWallet(input: {
  message: string;
  signature: string;
  label?: string;
}): Promise<WalletLinkResponse> {
  const response = await client.v1.wallet.link.$post({ json: input });
  // Link requires fresh step-up: surface a step-up 401 as the typed error so the
  // retry dialog opens instead of a generic API failure (WS-L.2.5a).
  return parseWithStepUp(response, walletLinkResponseSchema);
}

export async function fetchWallets(includeUnlinked = false): Promise<WalletListResponse> {
  const response = await client.v1.wallets.$get({
    query: includeUnlinked ? { include_unlinked: 'true' } : {},
  });
  return parseResponse(response, walletListResponseSchema);
}

export async function fetchWalletRiskState(walletId: string): Promise<WalletRiskStateResponse> {
  const response = await client.v1.wallets[':walletId']['risk-state'].$get({
    param: { walletId },
  });
  return parseResponse(response, walletRiskStateResponseSchema);
}

const unlinkResultSchema = z.union([
  z
    .object({
      wallet_account_id: z.string(),
      unlink_state: z.literal('pending_unlink'),
      finalize_after: z.string(),
    })
    .strict(),
  z
    .object({
      error: z.object({ code: z.string(), message: z.string() }),
      blocking_obligations: z.array(
        z.object({ type: z.string(), ref: z.string(), description: z.string() }),
      ),
    })
    .strict(),
]);
export type WalletUnlinkResult = z.infer<typeof unlinkResultSchema>;

export async function requestWalletUnlink(walletId: string): Promise<WalletUnlinkResult> {
  const response = await client.v1.wallet.unlink.request.$post({
    json: { wallet_account_id: walletId },
  });
  // 409 blocked is a valid, typed outcome (not an error) — read the body either way.
  if (response.status === 200 || response.status === 409) {
    const data: unknown = await response.json();
    return unlinkResultSchema.parse(data);
  }
  // Unlink requires fresh step-up: a step-up 401 becomes the typed error that
  // opens the retry dialog rather than a generic failure (WS-L.2.5b).
  return parseWithStepUp(response, unlinkResultSchema);
}

// --- Knomosis deployment manifest (WS-L.1.1a-1) ----------------------------

export async function fetchDeploymentManifest(
  deploymentId: string,
): Promise<KnomosisManifestResponse> {
  const response = await client.v1.knomosis.deployments[':deploymentId'].manifest.$get({
    param: { deploymentId },
  });
  return parseResponse(response, knomosisManifestResponseSchema);
}

// --- Governance simulation (WS-L.4) ----------------------------------------

export async function fetchGovernanceTab(roomId: string): Promise<GovernanceTabResponse> {
  const response = await client.v1.rooms[':roomId'].governance.$get({ param: { roomId } });
  return parseResponse(response, governanceTabResponseSchema);
}

export async function fetchGovernanceProposals(
  roomId: string,
): Promise<GovernanceProposalListResponse> {
  const response = await client.v1.rooms[':roomId'].governance.proposals.$get({
    param: { roomId },
  });
  return parseResponse(response, governanceProposalListResponseSchema);
}

export async function fetchComprehensionQuiz(roomId: string): Promise<ComprehensionQuizResponse> {
  const response = await client.v1.rooms[':roomId'].governance.comprehension.$get({
    param: { roomId },
  });
  return parseResponse(response, comprehensionQuizResponseSchema);
}

export async function submitComprehensionQuiz(
  roomId: string,
  input: { quiz_version: string; answers: Record<string, number> },
): Promise<ComprehensionSubmitResponse> {
  const response = await client.v1.rooms[':roomId'].governance.comprehension.$post({
    param: { roomId },
    json: input,
  });
  return parseResponse(response, comprehensionSubmitResponseSchema);
}

export async function fetchRoomReadiness(roomId: string): Promise<RoomReadinessResponse> {
  const response = await client.v1.rooms[':roomId'].governance.readiness.$get({
    param: { roomId },
  });
  return parseResponse(response, roomReadinessResponseSchema);
}
