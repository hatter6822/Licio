// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.2.2c — the mode-aware treasury panel: the simulated ledger keeps its
// undismissable simulation banner; the production dashboard shows ONLY
// last-reconciled balances plus the reconciliation/freeze state and reserved
// headroom; missing/mode-less treasuries render honest empty states.
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../lib/api.js';
import { checkA11y } from '../../test/axe.js';

const mockTab = vi.fn();
const mockGrants = vi.fn(() => ({ data: [] }));
vi.mock('../../lib/queries.js', () => ({
  useTreasuryTabQuery: () => mockTab(),
  useRoomGrantsQuery: () => mockGrants(),
  usePaymentIntentQuery: () => ({ data: undefined }),
  useWalletsQuery: () => ({ data: { items: [], nextCursor: null } }),
  useKnomosisManifestQuery: () => ({ data: undefined }),
}));

import { TreasuryPanel } from './TreasuryPanel.js';

const TREASURY = {
  treasury_id: '11111111-1111-4111-8111-111111111111',
  room_id: '22222222-2222-4222-8222-222222222222',
  deployment_id: '33333333-3333-4333-8333-333333333333',
  treasury_address: `0x${'ab'.repeat(20)}`,
  accepted_assets: ['USDC'],
  balances: [{ asset: 'USDC', amount: '1500000' }],
  balances_reconciled_at: '2026-07-01T00:00:00.000Z',
  deposit_limits: {
    per_user_per_period: '100000000',
    per_room_per_period: '1000000000',
    per_deposit_max: '50000000',
    period_seconds: 86_400,
  },
  freeze_state: 'active' as const,
  freeze_reason: null,
  pause_flags: { deposits: false, proposals: false, executions: false },
  reconciliation_state: 'synced' as const,
  reserved_by_category: { grant: '250000' },
  created_at: '2026-06-01T00:00:00.000Z',
};

beforeEach(() => {
  mockTab.mockReset();
  mockGrants.mockClear();
});

describe('TreasuryPanel (WS-M.2.2c)', () => {
  it('renders the simulated ledger with its undismissable banner', () => {
    mockTab.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        room_id: '22222222-2222-4222-8222-222222222222',
        simulation_label: 'SIMULATION — practice governance with play money',
        balances: [{ asset: 'SIM-USDC', amount: '5000000' }],
        updated_at: '2026-07-01T00:00:00.000Z',
      },
    });
    render(<TreasuryPanel roomId="r1" joined isRoomSteward={false} />);
    expect(
      screen.getByText('SIMULATION — practice governance with play money'),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing here moves real funds/i)).toBeInTheDocument();
    expect(screen.getByText('SIM-USDC')).toBeInTheDocument();
  });

  it('renders reconciled balances, reservation headroom, and the deposit form', async () => {
    mockTab.mockReturnValue({ isLoading: false, isError: false, data: { treasury: TREASURY } });
    const { container } = render(<TreasuryPanel roomId="r1" joined isRoomSteward={false} />);
    expect(screen.getByText(/balances \(last reconciled\)/i)).toBeInTheDocument();
    expect(screen.getByText('1.5')).toBeInTheDocument(); // 1500000 at 6 decimals
    expect(screen.getByText('Reconciled')).toBeInTheDocument();
    expect(screen.getByText(/reserved for passed proposals/i)).toBeInTheDocument();
    expect(screen.getByText(/grant: 250000/i)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: /contribute to the treasury/i })).toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('marks a divergent treasury and shows the freeze reason', () => {
    mockTab.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        treasury: {
          ...TREASURY,
          reconciliation_state: 'divergent' as const,
          freeze_state: 'frozen' as const,
          freeze_reason: 'Reconciliation divergence',
        },
      },
    });
    render(<TreasuryPanel roomId="r1" joined={false} isRoomSteward={false} />);
    expect(screen.getByText(/divergent — spending paused/i)).toBeInTheDocument();
    expect(screen.getByText(/treasury frozen: reconciliation divergence/i)).toBeInTheDocument();
    // Not a member: no deposit form.
    expect(screen.queryByRole('form', { name: /contribute/i })).not.toBeInTheDocument();
  });

  it('shows an honest empty state when no treasury is provisioned', () => {
    mockTab.mockReturnValue({ isLoading: false, isError: false, data: { treasury: null } });
    render(<TreasuryPanel roomId="r1" joined isRoomSteward />);
    expect(screen.getByText(/no treasury provisioned/i)).toBeInTheDocument();
  });

  it('renders a plain error state for a non-mode failure, and loading first', () => {
    mockTab.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    const loading = render(<TreasuryPanel roomId="r1" joined isRoomSteward={false} />);
    expect(screen.getByText(/loading treasury/i)).toBeInTheDocument();
    loading.unmount();
    mockTab.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
      error: new Error('network down'),
    });
    render(<TreasuryPanel roomId="r1" joined isRoomSteward={false} />);
    expect(screen.getByText(/couldn't load the treasury/i)).toBeInTheDocument();
  });

  it('shows the never-reconciled note, grants, and the steward export hint', () => {
    mockGrants.mockReturnValue({
      data: [
        {
          grant_id: '11111111-1111-4111-8111-111111111111',
          room_id: TREASURY.room_id,
          treasury_id: TREASURY.treasury_id,
          proposal_id: '22222222-2222-4222-8222-222222222222',
          recipient_ref: 'coop',
          purpose: 'River survey',
          amount: '1000000',
          asset: 'USDC',
          milestones: [
            {
              milestone_id: '33333333-3333-4333-8333-333333333333',
              description: 'All',
              amount: '1000000',
              state: 'pending',
              payment_intent_id: null,
            },
          ],
          milestone_state: 'pending',
          review_state: 'pending',
          payout_state: 'not_started',
          audit_summary: null,
          created_at: '2026-07-01T00:00:00.000Z',
        },
      ],
    } as never);
    mockTab.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        treasury: { ...TREASURY, balances: [], balances_reconciled_at: null },
      },
    });
    render(<TreasuryPanel roomId="r1" joined={false} isRoomSteward />);
    expect(screen.getByText(/not reconciled yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no reconciled balances yet/i)).toBeInTheDocument();
    expect(screen.getByText('River survey')).toBeInTheDocument();
    expect(screen.getByText(/1 milestones/i)).toBeInTheDocument();
    expect(screen.getByText(/versioned accounting export/i)).toBeInTheDocument();
  });

  it('explains a mode without a treasury surface (409) instead of erroring', () => {
    mockTab.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
      error: new ApiClientError('mode_invalid', 'No treasury surface', 409),
    });
    render(<TreasuryPanel roomId="r1" joined isRoomSteward={false} />);
    expect(screen.getByText(/no treasury in this mode/i)).toBeInTheDocument();
  });
});
