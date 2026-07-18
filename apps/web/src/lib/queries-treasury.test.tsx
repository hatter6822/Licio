// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The WS-M TanStack Query hooks: reads gate on `enabled` (nothing fetches for
// a closed surface), every governance write invalidates the ONE room prefix
// (profile + readiness + treasury + proposals + grants + audit all refresh),
// and the null-id polling reads stay disabled until they have a target.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  useAuditChainQuery,
  useCreateProposalMutation,
  useExecuteProposalMutation,
  useFileChallengeMutation,
  useGovernanceProfileQuery,
  useKnomosisDeploymentsQuery,
  useKnomosisManifestQuery,
  useModeTransitionMutation,
  usePaymentIntentQuery,
  useProposalListQuery,
  useRoomGrantsQuery,
  useRoomReadinessQuery,
  useSignProposalMutation,
  useTreasuryTabQuery,
} from './queries.js';

vi.mock('./treasury-api.js', () => ({
  fetchGovernanceProfile: vi.fn(async () => ({ profile: { governance_mode: 'testnet' } })),
  fetchReadinessForTarget: vi.fn(async (_room: string, target?: string) => ({
    target_mode: target ?? 'next-default',
    ready: false,
  })),
  requestModeTransition: vi.fn(async () => ({ governance_mode: 'testnet' })),
  fetchTreasuryTab: vi.fn(async () => ({ treasury: null })),
  fetchProposals: vi.fn(async () => []),
  createProductionProposal: vi.fn(async () => ({ proposal_id: 'p-1' })),
  signProposal: vi.fn(async () => ({ weight_snapshot: '1' })),
  executeProposal: vi.fn(async () => ({ execution_state: 'executed' })),
  fileChallenge: vi.fn(async () => ({ challenge_id: 'c-1' })),
  fetchGrants: vi.fn(async () => []),
  fetchPaymentIntent: vi.fn(async () => ({ execution_state: 'pending' })),
  fetchAuditChainVerification: vi.fn(async () => ({
    valid: true,
    chained_entries: 3,
    problems: [],
  })),
}));
vi.mock('./wallet-api.js', () => ({
  fetchDeploymentManifest: vi.fn(async () => ({ chain_id: 1337 })),
  fetchDeployments: vi.fn(async () => ({ deployments: [] })),
}));

const treasuryApi = await import('./treasury-api.js');
const walletApi = await import('./wallet-api.js');

const ROOM = '77777777-7777-4777-8777-777777777777';

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('WS-M read hooks (enabled-gated, zod-validated upstream)', () => {
  it('fetches profile/treasury/proposals/grants/audit when enabled', async () => {
    const client = makeClient();
    const w = wrapper(client);
    const profile = renderHook(() => useGovernanceProfileQuery(ROOM, true), { wrapper: w });
    const treasury = renderHook(() => useTreasuryTabQuery(ROOM, true), { wrapper: w });
    const proposals = renderHook(() => useProposalListQuery(ROOM, true), { wrapper: w });
    const grants = renderHook(() => useRoomGrantsQuery(ROOM, true), { wrapper: w });
    const audit = renderHook(() => useAuditChainQuery(ROOM, true), { wrapper: w });
    await waitFor(() => expect(profile.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(audit.result.current.data?.valid).toBe(true));
    expect(treasury.result.current.data).toEqual({ treasury: null });
    expect(proposals.result.current.data).toEqual([]);
    expect(grants.result.current.data).toEqual([]);
  });

  it('stays idle while disabled (fail-closed surfaces fetch nothing)', async () => {
    const client = makeClient();
    const w = wrapper(client);
    renderHook(() => useGovernanceProfileQuery(ROOM, false), { wrapper: w });
    renderHook(() => useTreasuryTabQuery(ROOM, false), { wrapper: w });
    renderHook(() => usePaymentIntentQuery(ROOM, null), { wrapper: w });
    renderHook(() => useKnomosisManifestQuery(null), { wrapper: w });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(treasuryApi.fetchGovernanceProfile).not.toHaveBeenCalled();
    expect(treasuryApi.fetchTreasuryTab).not.toHaveBeenCalled();
    expect(treasuryApi.fetchPaymentIntent).not.toHaveBeenCalled();
    expect(walletApi.fetchDeploymentManifest).not.toHaveBeenCalled();
  });

  it('forwards the readiness target and defaults it to the next mode', async () => {
    const client = makeClient();
    const w = wrapper(client);
    const explicit = renderHook(() => useRoomReadinessQuery(ROOM, 'mature_production', true), {
      wrapper: w,
    });
    await waitFor(() =>
      expect(explicit.result.current.data?.target_mode).toBe('mature_production'),
    );
    const defaulted = renderHook(() => useRoomReadinessQuery(ROOM, null, true), { wrapper: w });
    await waitFor(() => expect(defaulted.result.current.data?.target_mode).toBe('next-default'));
    expect(treasuryApi.fetchReadinessForTarget).toHaveBeenLastCalledWith(ROOM, undefined);
  });

  it('polls a payment intent once it has an id, and reads deployments/manifest', async () => {
    const client = makeClient();
    const w = wrapper(client);
    const intent = renderHook(() => usePaymentIntentQuery(ROOM, 'i-1'), { wrapper: w });
    await waitFor(() => expect(intent.result.current.data?.execution_state).toBe('pending'));
    const manifest = renderHook(() => useKnomosisManifestQuery('d-1'), { wrapper: w });
    await waitFor(() => expect(manifest.result.current.data?.chain_id).toBe(1337));
    const deployments = renderHook(() => useKnomosisDeploymentsQuery(true), { wrapper: w });
    await waitFor(() => expect(deployments.result.current.data?.deployments).toEqual([]));
  });
});

describe('WS-M write hooks invalidate the room prefix', () => {
  async function expectRoomInvalidation(
    mutate: (hook: { mutateAsync: (input: never) => Promise<unknown> }) => Promise<unknown>,
    useHook: () => { mutateAsync: (input: never) => Promise<unknown> },
  ): Promise<void> {
    const client = makeClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(useHook, { wrapper: wrapper(client) });
    await mutate(result.current);
    // ONE prefix invalidation covers profile/readiness/treasury/proposals/
    // grants/audit — they are all ['room', roomId, …]-keyed.
    expect(spy).toHaveBeenCalledWith({ queryKey: ['room', ROOM] });
  }

  it('mode transition, create, sign, execute, and challenge all refresh the room', async () => {
    await expectRoomInvalidation(
      (hook) => hook.mutateAsync({ target_mode: 'testnet', reason: 'go' } as never),
      () => useModeTransitionMutation(ROOM),
    );
    await expectRoomInvalidation(
      (hook) => hook.mutateAsync({ title: 't' } as never),
      () => useCreateProposalMutation(ROOM),
    );
    await expectRoomInvalidation(
      (hook) => hook.mutateAsync({ proposalId: 'p-1', request: {} } as never),
      () => useSignProposalMutation(ROOM),
    );
    await expectRoomInvalidation(
      (hook) => hook.mutateAsync('p-1' as never),
      () => useExecuteProposalMutation(ROOM),
    );
    await expectRoomInvalidation(
      (hook) => hook.mutateAsync({ proposalId: 'p-1', request: {} } as never),
      () => useFileChallengeMutation(ROOM),
    );
    expect(treasuryApi.requestModeTransition).toHaveBeenCalledTimes(1);
    expect(treasuryApi.createProductionProposal).toHaveBeenCalledTimes(1);
    expect(treasuryApi.signProposal).toHaveBeenCalledTimes(1);
    expect(treasuryApi.executeProposal).toHaveBeenCalledTimes(1);
    expect(treasuryApi.fileChallenge).toHaveBeenCalledTimes(1);
  });
});
