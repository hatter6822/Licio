// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.4 — the proposal surface: production cards show the lifecycle states +
// exact tally (governance counts, never applause), voting exists only while
// the window is open, execution is steward-only on passed proposals, and the
// create form posts the full WS-M draft with an idempotency key.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../test/axe.js';

const mockProposals = vi.fn();
const mockCreate = vi.fn();
const mockExecute = vi.fn();
vi.mock('../../lib/queries.js', () => ({
  useProposalListQuery: () => mockProposals(),
  useTreasuryTabQuery: () => ({ data: undefined }),
  useKnomosisDeploymentsQuery: () => ({ data: { deployments: [] } }),
  useKnomosisManifestQuery: () => ({ data: undefined }),
  useWalletsQuery: () => ({ data: { items: [], nextCursor: null } }),
  useCreateProposalMutation: () => ({ mutateAsync: mockCreate, isPending: false }),
  useSignProposalMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useExecuteProposalMutation: () => ({ mutateAsync: mockExecute, isPending: false }),
  useFileChallengeMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { ProposalsPanel } from './ProposalsPanel.js';

const PRODUCTION_PROPOSAL = {
  proposal_id: '77777777-7777-4777-8777-777777777777',
  room_id: '22222222-2222-4222-8222-222222222222',
  proposer_user_id: null,
  proposal_type: 'capped_grant',
  title: 'Fund the river survey',
  plain_language_summary: 'Pay a hydrologist to survey the river.',
  category: 'grant',
  requested_amount: '1000000',
  asset: 'USDC',
  recipient_ref: 'hydrologist-coop',
  conflict_disclosures: 'None.',
  risk_assessment: 'Low.',
  requested_action: {},
  expected_deliverable: 'A survey report.',
  law_pack_version_id: null,
  preflight_state: 'passed' as const,
  voting_state: 'passed' as const,
  challenge_state: 'none' as const,
  execution_state: 'not_executed' as const,
  tally: {
    outcome: 'passed' as const,
    quorum_met: true,
    approve: '3',
    reject: '1',
    abstain: '0',
    distinct_voters: 4,
    turnout: 0.8,
  },
  deliberation_ends_at: null,
  voting_ends_at: null,
  challenge_window_ends_at: null,
  executable_after: null,
  created_at: '2026-07-01T00:00:00.000Z',
  executed_at: null,
};

const SIM_PROPOSAL = {
  proposal_id: '88888888-8888-4888-8888-888888888888',
  room_id: '22222222-2222-4222-8222-222222222222',
  proposer_user_id: null,
  proposal_type: 'capped_grant',
  title: 'Practice proposal',
  plain_language_summary: 'A simulated practice run.',
  requested_amount: null,
  asset: null,
  recipient_ref: null,
  conflict_disclosures: null,
  risk_assessment: 'None.',
  requested_action: {},
  expected_deliverable: 'Practice.',
  preflight_state: 'passed' as const,
  voting_state: 'open' as const,
  challenge_state: 'none' as const,
  execution_state: 'not_executed' as const,
  votes_approve: 1,
  votes_reject: 0,
  votes_abstain: 0,
  executable_after: null,
  simulation_mode: true,
  created_at: '2026-07-01T00:00:00.000Z',
  executed_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProposalsPanel (WS-M.4)', () => {
  it('renders a production proposal with its states and exact tally', async () => {
    mockProposals.mockReturnValue({ isLoading: false, data: [PRODUCTION_PROPOSAL] });
    const { container } = render(
      <ProposalsPanel roomId="r1" joined={false} isRoomSteward={false} />,
    );
    expect(screen.getByText('Fund the river survey')).toBeInTheDocument();
    expect(screen.getByText(/outcome passed — approve 3, reject 1/i)).toBeInTheDocument();
    // Voting closed: no ballot buttons; not steward: no execute.
    expect(screen.queryByRole('button', { name: /vote approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^execute$/i })).not.toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('marks simulated proposals distinctly (practice, read-only here)', () => {
    mockProposals.mockReturnValue({ isLoading: false, data: [SIM_PROPOSAL] });
    render(<ProposalsPanel roomId="r1" joined isRoomSteward={false} />);
    expect(screen.getByText('simulation')).toBeInTheDocument();
    expect(screen.getByText('Practice proposal')).toBeInTheDocument();
  });

  it('offers ballot buttons to members only while voting is open', () => {
    mockProposals.mockReturnValue({
      isLoading: false,
      data: [{ ...PRODUCTION_PROPOSAL, voting_state: 'open' as const, tally: null }],
    });
    render(<ProposalsPanel roomId="r1" joined isRoomSteward={false} />);
    expect(screen.getByRole('button', { name: /vote approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /vote reject/i })).toBeInTheDocument();
  });

  it('lets a steward execute a passed proposal', async () => {
    mockProposals.mockReturnValue({ isLoading: false, data: [PRODUCTION_PROPOSAL] });
    mockExecute.mockResolvedValue({ ...PRODUCTION_PROPOSAL, execution_state: 'timelocked' });
    render(<ProposalsPanel roomId="r1" joined isRoomSteward />);
    fireEvent.click(screen.getByRole('button', { name: /^execute$/i }));
    await waitFor(() => expect(mockExecute).toHaveBeenCalledWith(PRODUCTION_PROPOSAL.proposal_id));
    expect(screen.getByText(/execution: timelocked/i)).toBeInTheDocument();
  });

  it('posts the full production draft with an idempotency key', async () => {
    mockProposals.mockReturnValue({ isLoading: false, data: [] });
    mockCreate.mockResolvedValue(PRODUCTION_PROPOSAL);
    render(<ProposalsPanel roomId="r1" joined isRoomSteward={false} />);
    fireEvent.click(screen.getByRole('button', { name: /open a proposal/i }));
    fireEvent.change(screen.getByLabelText(/^title/i), {
      target: { value: 'Fund the river survey' },
    });
    fireEvent.change(screen.getByLabelText(/plain-language summary/i), {
      target: { value: 'Pay a hydrologist.' },
    });
    fireEvent.change(screen.getByLabelText(/risk assessment/i), { target: { value: 'Low.' } });
    fireEvent.change(screen.getByLabelText(/expected deliverable/i), {
      target: { value: 'A report.' },
    });
    fireEvent.change(screen.getByLabelText(/amount \(minor units\)/i), {
      target: { value: '1000000' },
    });
    fireEvent.change(screen.getByLabelText(/^asset/i), { target: { value: 'USDC' } });
    fireEvent.change(screen.getByLabelText(/recipient reference/i), {
      target: { value: 'hydrologist-coop' },
    });
    fireEvent.change(screen.getByLabelText(/conflict-of-interest/i), {
      target: { value: 'None.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^open proposal$/i }));
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          proposal_type: 'capped_grant',
          title: 'Fund the river survey',
          requested_amount: '1000000',
          asset: 'USDC',
          recipient_ref: 'hydrologist-coop',
          conflict_disclosures: 'None.',
          idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
      ),
    );
  });

  it('shows an honest empty state when the room has no proposals', () => {
    mockProposals.mockReturnValue({ isLoading: false, data: [] });
    render(<ProposalsPanel roomId="r1" joined={false} isRoomSteward={false} />);
    expect(screen.getByText(/no proposals yet/i)).toBeInTheDocument();
  });
});
