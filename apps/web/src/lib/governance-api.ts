// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U AI-governed-rooms client flows (SPEC §16.6, §24.6). Typed against the BFF
// `/v1/rooms/*` governance surface; every response is zod-validated before it can
// reach the TanStack Query cache. Reads power the in-room transparency view (who
// governs the room, the active model, recent agent actions); the steward writes
// (propose / approve) are the elected-steward's two powers.
import {
  type GovernanceApproveResponse,
  type GovernanceModelDownloadResponse,
  type GovernanceModelListResponse,
  type GovernanceProposeResponse,
  type GovernedByResponse,
  governanceApproveResponseSchema,
  governanceModelDownloadResponseSchema,
  governanceModelListResponseSchema,
  governanceProposeResponseSchema,
  governedByResponseSchema,
  type StewardSeatResponse,
  stewardSeatResponseSchema,
} from '@licio/shared';
import { client, parseResponse } from './api.js';

export async function fetchStewardSeat(roomId: string): Promise<StewardSeatResponse> {
  const res = await client.v1.rooms[':roomId'].steward.$get({ param: { roomId } });
  return parseResponse(res, stewardSeatResponseSchema);
}

export async function fetchGovernedBy(roomId: string): Promise<GovernedByResponse> {
  const res = await client.v1.rooms[':roomId'].governance.agent.$get({ param: { roomId } });
  return parseResponse(res, governedByResponseSchema);
}

export async function fetchGovernanceModels(roomId: string): Promise<GovernanceModelListResponse> {
  const res = await client.v1.rooms[':roomId'].governance.models.$get({ param: { roomId } });
  return parseResponse(res, governanceModelListResponseSchema);
}

export async function downloadGovernanceModel(
  roomId: string,
  modelId: string,
): Promise<GovernanceModelDownloadResponse> {
  const res = await client.v1.rooms[':roomId'].governance.models[':modelId'].download.$get({
    param: { roomId, modelId },
  });
  return parseResponse(res, governanceModelDownloadResponseSchema);
}

export async function proposeGovernanceModel(
  roomId: string,
  body: { bundle: unknown; prompt_text: string },
): Promise<GovernanceProposeResponse> {
  const res = await client.v1.rooms[':roomId'].governance.models.$post({
    param: { roomId },
    json: body,
  });
  return parseResponse(res, governanceProposeResponseSchema);
}

export async function approveGovernanceModel(
  roomId: string,
  modelId: string,
): Promise<GovernanceApproveResponse> {
  const res = await client.v1.rooms[':roomId'].governance.models[':modelId'].approve.$post({
    param: { roomId, modelId },
    json: { election_id: null },
  });
  return parseResponse(res, governanceApproveResponseSchema);
}
