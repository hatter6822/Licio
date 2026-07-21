// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U AI-governed-rooms client flows (SPEC §16.6, §24.6). Typed against the BFF
// `/v1/rooms/*` governance surface; every response is zod-validated before it can
// reach the TanStack Query cache. Reads power the in-room transparency view (who
// governs the room, the active model, recent agent actions); the steward writes
// (propose / approve) are the elected-steward's two powers.
import {
  type GovernanceModelDownloadResponse,
  type GovernanceModelListResponse,
  type GovernanceProposeResponse,
  type GovernedByResponse,
  governanceModelDownloadResponseSchema,
  governanceModelListResponseSchema,
  governanceProposeResponseSchema,
  governedByResponseSchema,
  type RatificationBallotResponse,
  type RatificationChoiceWire,
  type RatificationOpenResponse,
  type RatificationViewResponse,
  ratificationBallotResponseSchema,
  ratificationOpenResponseSchema,
  ratificationViewResponseSchema,
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

export async function openRatification(
  roomId: string,
  modelId: string,
): Promise<RatificationOpenResponse> {
  const res = await client.v1.rooms[':roomId'].governance.models[':modelId'].ratification.$post({
    param: { roomId, modelId },
    json: { law_pack_id: null },
  });
  return parseResponse(res, ratificationOpenResponseSchema);
}

export async function castRatificationBallot(
  roomId: string,
  voteId: string,
  choice: RatificationChoiceWire,
): Promise<RatificationBallotResponse> {
  const res = await client.v1.rooms[':roomId'].governance.ratifications[':voteId'].ballot.$post({
    param: { roomId, voteId },
    json: { choice },
  });
  return parseResponse(res, ratificationBallotResponseSchema);
}

/** The steward's last-line-of-defence against an improper open vote: cancel it
 *  with NO outcome (the candidate stays eligible; a fresh vote may open). */
export async function cancelRatification(
  roomId: string,
  voteId: string,
): Promise<RatificationBallotResponse> {
  const res = await client.v1.rooms[':roomId'].governance.ratifications[':voteId'].cancel.$post({
    param: { roomId, voteId },
  });
  return parseResponse(res, ratificationBallotResponseSchema);
}

export async function fetchRatification(roomId: string): Promise<RatificationViewResponse> {
  const res = await client.v1.rooms[':roomId'].governance.ratification.$get({ param: { roomId } });
  return parseResponse(res, ratificationViewResponseSchema);
}
