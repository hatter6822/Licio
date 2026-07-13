// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Client for the DEVELOPMENT traffic-simulator control surface
// (/v1/dev/simulator). The server routes exist ONLY when the API is booted in
// development, so this whole module is used behind an `import.meta.env.DEV`
// gate (tree-shaken from production builds) and every call fails soft when the
// surface is absent (a production API returns 404 for these paths). The routes
// are sessionless and outside the RPC `AppType`, so these calls use a plain
// fetch with the custom control header — never the CSRF-serialized RPC client.
// Every response is zod-validated before use, the same trust-boundary rule as
// the rest of the client.

import {
  SIMULATOR_CONTROL_HEADER,
  type SimulatorConfigureRequest,
  type SimulatorDebateFastForwardRequest,
  type SimulatorDebateFastForwardResponse,
  type SimulatorStartRequest,
  type SimulatorStatus,
  simulatorDebateFastForwardResponseSchema,
  simulatorStatusSchema,
} from '@licio/shared';

const API_BASE: string =
  (import.meta.env['VITE_API_URL'] as string | undefined)?.replace(/\/$/, '') ?? '';

const BASE = `${API_BASE}/v1/dev/simulator`;

/** Thrown when the surface is unreachable (production, or the dev API booted
 *  with LICIO_SIM=off) — the panel renders an "unavailable" state, never an
 *  error toast. */
export class SimulatorUnavailableError extends Error {
  constructor() {
    super('The dev traffic simulator is not available on this API.');
    this.name = 'SimulatorUnavailableError';
  }
}

async function readStatus(response: Response): Promise<SimulatorStatus> {
  if (response.status === 404) throw new SimulatorUnavailableError();
  if (!response.ok) throw new Error(`simulator request failed: ${response.status}`);
  const data: unknown = await response.json();
  return simulatorStatusSchema.parse(data);
}

export async function fetchSimulatorStatus(signal?: AbortSignal): Promise<SimulatorStatus> {
  const response = await fetch(`${BASE}/status`, {
    method: 'GET',
    ...(signal ? { signal } : {}),
  }).catch(() => {
    throw new SimulatorUnavailableError();
  });
  return readStatus(response);
}

const controlHeaders: Record<string, string> = {
  'content-type': 'application/json',
  [SIMULATOR_CONTROL_HEADER]: '1',
};

export async function startSimulator(
  request: SimulatorStartRequest = {},
): Promise<SimulatorStatus> {
  const response = await fetch(`${BASE}/start`, {
    method: 'POST',
    headers: controlHeaders,
    body: JSON.stringify(request),
  });
  return readStatus(response);
}

export async function stopSimulator(): Promise<SimulatorStatus> {
  const response = await fetch(`${BASE}/stop`, {
    method: 'POST',
    headers: controlHeaders,
    body: '{}',
  });
  return readStatus(response);
}

export async function configureSimulator(
  request: SimulatorConfigureRequest,
): Promise<SimulatorStatus> {
  const response = await fetch(`${BASE}/configure`, {
    method: 'POST',
    headers: controlHeaders,
    body: JSON.stringify(request),
  });
  return readStatus(response);
}

/**
 * WS-T fast-forward: jump a debate to its next lifecycle milestone (lock /
 * verdict / final resolution) so a developer can watch a REAL spec-window
 * (24h) arena resolve on demand. DEV-only, like the rest of this surface.
 */
export async function fastForwardDebate(
  debateId: string,
  request: SimulatorDebateFastForwardRequest,
): Promise<SimulatorDebateFastForwardResponse> {
  const response = await fetch(`${BASE}/debates/${encodeURIComponent(debateId)}/fast-forward`, {
    method: 'POST',
    headers: controlHeaders,
    body: JSON.stringify(request),
  }).catch(() => {
    throw new SimulatorUnavailableError();
  });
  if (response.status === 404) throw new SimulatorUnavailableError();
  if (!response.ok) throw new Error(`simulator request failed: ${response.status}`);
  const data: unknown = await response.json();
  return simulatorDebateFastForwardResponseSchema.parse(data);
}
