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
const mockSignMutation = vi.fn();
const mockChallenge = vi.fn();
const mockTreasuryTab = vi.fn(() => ({ data: undefined }));
const mockDeployments = vi.fn(() => ({ data: { deployments: [] } }));
const mockManifest = vi.fn(() => ({ data: undefined }));
const mockWallets = vi.fn(() => ({ data: { items: [], nextCursor: null } }));
vi.mock('../../lib/queries.js', () => ({
  useProposalListQuery: () => mockProposals(),
  useTreasuryTabQuery: () => mockTreasuryTab(),
  useKnomosisDeploymentsQuery: () => mockDeployments(),
  useKnomosisManifestQuery: () => mockManifest(),
  useWalletsQuery: () => mockWallets(),
  useCreateProposalMutation: () => ({ mutateAsync: mockCreate, isPending: false }),
  useSignProposalMutation: () => ({ mutateAsync: mockSignMutation, isPending: false }),
  useExecuteProposalMutation: () => ({ mutateAsync: mockExecute, isPending: false }),
  useFileChallengeMutation: () => ({ mutateAsync: mockChallenge, isPending: false }),
}));

const mockSignTypedData = vi.fn();
vi.mock('../../lib/wallet-signing.js', () => ({
  discoverProviders: () => Promise.resolve([{ info: { rdns: 'io.test' }, provider: {} }]),
  requestAccount: () => Promise.resolve(`0x${'cd'.repeat(20)}`),
  freshNonce: () => '42',
  signatureExpiration: () => '9999999999',
  signTypedData: (...args: unknown[]) => mockSignTypedData(...args),
}));

import { ProposalsPanel } from './ProposalsPanel.js';

/** Wire a full signing context: treasury deployment + manifest + active wallet. */
function armVoteContext(): void {
  mockTreasuryTab.mockReturnValue({
    data: {
      treasury: {
        deployment_id: '66666666-6666-4666-8666-666666666666',
      },
    },
  } as never);
  mockManifest.mockReturnValue({
    data: {
      deployment_id: '66666666-6666-4666-8666-666666666666',
      chain_id: 1337,
      chain_name: 'Local Anvil',
      eip712_domain_version: '1',
      verifying_contract_address: `0x${'ef'.repeat(20)}`,
    },
  } as never);
  mockWallets.mockReturnValue({
    data: {
      items: [
        {
          wallet_account_id: '99999999-9999-4999-8999-999999999999',
          label: 'Wallet 1',
          address_truncated: '0xcdcd…cdcd',
          chain_id: 1337,
          wallet_type: 'eoa',
          unlink_state: 'active',
          risk_state: 'normal',
          linked_at: '2026-06-01T00:00:00.000Z',
          last_used_at: null,
        },
      ],
      nextCursor: null,
    },
  } as never);
}

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
  mockTreasuryTab.mockReturnValue({ data: undefined } as never);
  mockDeployments.mockReturnValue({ data: { deployments: [] } } as never);
  mockManifest.mockReturnValue({ data: undefined } as never);
  mockWallets.mockReturnValue({ data: { items: [], nextCursor: null } } as never);
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

  it('walks the ballot flow: preview → sign → the typed sign request', async () => {
    armVoteContext();
    const open = { ...PRODUCTION_PROPOSAL, voting_state: 'open' as const, tally: null };
    mockProposals.mockReturnValue({ isLoading: false, data: [open] });
    mockSignTypedData.mockResolvedValue({
      signature: `0x${'11'.repeat(65)}`,
      message: { roomId: open.room_id, proposalId: open.proposal_id },
    });
    mockSignMutation.mockResolvedValue({
      signature_id: '55555555-5555-4555-8555-555555555555',
      weight_snapshot: '1',
      eligibility_reason: 'eligible',
      tally: {
        outcome: 'open',
        quorum_met: false,
        approve: '1',
        reject: '0',
        abstain: '0',
        distinct_voters: 1,
        turnout: 0.25,
      },
    });
    render(<ProposalsPanel roomId={open.room_id} joined isRoomSteward={false} />);

    fireEvent.click(screen.getByRole('button', { name: /vote approve/i }));
    // The WS-L.2.6 full-disclosure preview opens with the exact-outcome button.
    const signButton = await screen.findByRole('button', { name: /^sign proposal$/i });
    fireEvent.click(signButton);

    await waitFor(() =>
      expect(mockSignMutation).toHaveBeenCalledWith({
        proposalId: open.proposal_id,
        request: expect.objectContaining({
          purpose: 'vote',
          choice: 'approve',
          deployment_id: '66666666-6666-4666-8666-666666666666',
          wallet_account_id: '99999999-9999-4999-8999-999999999999',
          signature: `0x${'11'.repeat(65)}`,
        }),
      }),
    );
    expect(await screen.findByText(/vote recorded with weight 1/i)).toBeInTheDocument();
  });

  it('explains a missing wallet instead of opening the ballot preview', async () => {
    // No treasury/manifest/wallet wired: voteContext is null.
    const open = { ...PRODUCTION_PROPOSAL, voting_state: 'open' as const, tally: null };
    mockProposals.mockReturnValue({ isLoading: false, data: [open] });
    render(<ProposalsPanel roomId="r1" joined isRoomSteward={false} />);
    fireEvent.click(screen.getByRole('button', { name: /vote approve/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/active linked wallet/i);
    expect(mockSignTypedData).not.toHaveBeenCalled();
  });

  it('surfaces a wallet signing refusal without recording a ballot', async () => {
    armVoteContext();
    const open = { ...PRODUCTION_PROPOSAL, voting_state: 'open' as const, tally: null };
    mockProposals.mockReturnValue({ isLoading: false, data: [open] });
    mockSignTypedData.mockResolvedValue(null);
    render(<ProposalsPanel roomId={open.room_id} joined isRoomSteward={false} />);
    fireEvent.click(screen.getByRole('button', { name: /vote reject/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^sign proposal$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/did not sign/i);
    expect(mockSignMutation).not.toHaveBeenCalled();
  });

  it('files a challenge with its type and description', async () => {
    mockProposals.mockReturnValue({ isLoading: false, data: [PRODUCTION_PROPOSAL] });
    mockChallenge.mockResolvedValue({ challenge_id: '44444444-4444-4444-8444-444444444444' });
    render(<ProposalsPanel roomId="r1" joined isRoomSteward={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^challenge$/i }));
    fireEvent.change(screen.getByLabelText(/what is wrong with this proposal/i), {
      target: { value: 'The quorum math is off.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /file challenge/i }));
    await waitFor(() =>
      expect(mockChallenge).toHaveBeenCalledWith({
        proposalId: PRODUCTION_PROPOSAL.proposal_id,
        request: expect.objectContaining({
          description: 'The quorum math is off.',
          evidence_refs: [],
        }),
      }),
    );
    expect(await screen.findByText(/challenge filed for review/i)).toBeInTheDocument();
  });
});
