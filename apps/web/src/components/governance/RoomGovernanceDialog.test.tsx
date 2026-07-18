// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U room-governance modal: the three governance concerns open in ONE focused
// modal whose tabs (Overview / Models & voting / Settings) each fit a single
// view. The Settings tab is steward-only (rollout-flag gated); the Models tab
// renders an honest empty registry rather than nothing; and the whole surface is
// accessible (dialog + tablist semantics). No applause primitives.
import type { RoomDetail } from '@licio/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../test/axe.js';

vi.mock('../../lib/queries.js', () => ({
  // GovernedByPanel — the platform baseline (no agent) keeps the fixture simple.
  useGovernedByQuery: () => ({
    isLoading: false,
    isError: false,
    data: { active: false, frozen: false, model_id: null, granted: [], recent_actions: [] },
  }),
  // StewardModelManager — a plain member with an empty registry and no open vote.
  useStewardSeatQuery: () => ({ data: { seat: null } }),
  useGovernanceModelsQuery: () => ({
    isLoading: false,
    isError: false,
    data: { steward_user_id: null, models: [] },
  }),
  useRatificationQuery: () => ({ isLoading: false, isError: false, data: { vote: null } }),
  useProposeModelMutation: () => ({ mutate: () => {}, isPending: false }),
  useOpenRatificationMutation: () => ({ mutate: () => {}, isPending: false }),
  useCastBallotMutation: () => ({ mutate: () => {}, isPending: false }),
  // RoomSettingsForm (Settings tab).
  useUpdateRoomSettingsMutation: () => ({ mutate: () => {}, isPending: false }),
  useChangeRoomVisibilityMutation: () => ({ mutate: () => {}, isPending: false }),
  useRoomLensesQuery: () => ({ data: [] }),
  useCreateLensMutation: () => ({ mutate: () => {}, isPending: false, isError: false }),
  // WS-M panels (Lifecycle / Treasury / Proposals tabs).
  useGovernanceProfileQuery: () => ({ isLoading: false, isError: false, data: undefined }),
  useRoomReadinessQuery: () => ({ isLoading: true, isError: false, data: undefined }),
  useModeTransitionMutation: () => ({ mutateAsync: () => Promise.resolve(), isPending: false }),
  useAuditChainQuery: () => ({ data: undefined, isFetching: false, refetch: () => {} }),
  useTreasuryTabQuery: () => ({ isLoading: true, isError: false, data: undefined }),
  useRoomGrantsQuery: () => ({ data: [] }),
  usePaymentIntentQuery: () => ({ data: undefined }),
  useProposalListQuery: () => ({ isLoading: false, isError: false, data: [] }),
  useTreasuryDashboardQuery: () => ({ data: undefined }),
  useKnomosisDeploymentsQuery: () => ({ data: undefined }),
  useKnomosisManifestQuery: () => ({ data: undefined }),
  useWalletsQuery: () => ({ data: undefined }),
  useCreateProposalMutation: () => ({ mutateAsync: () => Promise.resolve(), isPending: false }),
  useCreateSimProposalMutation: () => ({ mutateAsync: () => Promise.resolve(), isPending: false }),
  useSignProposalMutation: () => ({ mutateAsync: () => Promise.resolve(), isPending: false }),
  useExecuteProposalMutation: () => ({ mutateAsync: () => Promise.resolve(), isPending: false }),
  useFileChallengeMutation: () => ({ mutateAsync: () => Promise.resolve(), isPending: false }),
}));

import { useFeatureFlagStore } from '../../stores/feature-flags.js';
import { RoomGovernanceDialog } from './RoomGovernanceDialog.js';

function baseRoom(over: Partial<RoomDetail> = {}): RoomDetail {
  return {
    room_id: 'r1',
    name: 'Hydrology',
    slug: 'hydrology',
    room_type: 'global_topic',
    visibility: 'public',
    join_model: 'open',
    posting_policy: 'all_members',
    description: 'Water talk.',
    thread_count: 0,
    member_count: 3,
    latest_activity_at: null,
    governance_mode: 'ordinary',
    joined: true,
    created_at: '2026-01-01T00:00:00.000Z',
    lenses: [],
    my_lens_id: null,
    stewards: [],
    governance: null,
    charter_summary: null,
    join_pending: false,
    can_post: true,
    ...over,
  };
}

function renderDialog(props: Partial<React.ComponentProps<typeof RoomGovernanceDialog>> = {}) {
  return render(
    <RoomGovernanceDialog
      open
      onClose={() => {}}
      roomId="r1"
      room={baseRoom()}
      showSettings={false}
      {...props}
    />,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  useFeatureFlagStore.getState().reset();
});

describe('RoomGovernanceDialog (WS-U §16.6/§24.6)', () => {
  it('renders nothing when closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens as a labelled modal with the Overview tab selected by default', () => {
    renderDialog();
    expect(
      screen.getByRole('dialog', { name: /governance, transparency & settings/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: /room governance sections/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /how it's governed/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Overview → the "governed by" transparency view (mocked as baseline).
    expect(screen.getByText(/platform moderation baseline/i)).toBeInTheDocument();
  });

  it('shows an honest empty registry on the Models tab (embedded always renders)', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('tab', { name: /models & voting/i }));
    expect(screen.getByText(/no models have been proposed yet/i)).toBeInTheDocument();
    // Embedded: no duplicate per-panel card heading (the tab supplies the name).
    expect(
      screen.queryByRole('heading', { name: /community governance models/i }),
    ).not.toBeInTheDocument();
  });

  it('hides the Settings tab from a non-steward (or with the rollout flag off)', () => {
    renderDialog({ showSettings: false });
    expect(screen.queryByRole('tab', { name: /^settings$/i })).not.toBeInTheDocument();
  });

  it('shows the steward-only Settings tab and its room settings when enabled', () => {
    renderDialog({ showSettings: true, room: baseRoom({ is_steward: true }) });
    const settingsTab = screen.getByRole('tab', { name: /^settings$/i });
    expect(settingsTab).toBeInTheDocument();
    fireEvent.click(settingsTab);
    expect(screen.getByRole('heading', { name: /room settings/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/who can post/i)).toBeInTheDocument();
  });

  it('has no accessibility violations while open', async () => {
    renderDialog({ showSettings: true, room: baseRoom({ is_steward: true }) });
    // The dialog is portaled to <body>, so assert over the whole document.
    expect(await checkA11y(document.body)).toHaveNoViolations();
  });

  // --- WS-M tabs (fail-closed on the governance flag) ------------------------

  it('hides every WS-M tab while the governance flag is off (fail-closed)', () => {
    renderDialog({ room: baseRoom({ governance_mode: 'testnet' }) });
    expect(screen.queryByRole('tab', { name: /mode & readiness/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /treasury/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /proposals/i })).not.toBeInTheDocument();
  });

  it('shows the lifecycle tab (but not treasury/proposals) for an ordinary room', () => {
    useFeatureFlagStore.setState((state) => ({
      flags: { ...state.flags, governanceEnabled: true },
    }));
    renderDialog();
    expect(screen.getByRole('tab', { name: /mode & readiness/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /treasury/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /proposals/i })).not.toBeInTheDocument();
  });

  it('shows treasury + proposals once the room leaves ordinary, with the mode badge', () => {
    useFeatureFlagStore.setState((state) => ({
      flags: { ...state.flags, governanceEnabled: true },
    }));
    renderDialog({ room: baseRoom({ governance_mode: 'testnet' }) });
    // The overview leads with the server-derived mode indicator (WS-M.1.1c).
    expect(screen.getByText('Testnet')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /treasury/i })).toBeInTheDocument();
    const proposalsTab = screen.getByRole('tab', { name: /proposals/i });
    fireEvent.click(proposalsTab);
    expect(screen.getByText(/no proposals yet/i)).toBeInTheDocument();
  });
});
