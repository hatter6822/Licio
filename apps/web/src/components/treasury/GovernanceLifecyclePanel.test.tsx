// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.1/6 — the lifecycle tab: mode + description, the readiness checklist,
// the steward emergency freeze (unfreeze honestly labelled platform-only), and
// on-demand audit-chain verification.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../test/axe.js';

const mockProfile = vi.fn();
const mockAudit = vi.fn();
vi.mock('../../lib/queries.js', () => ({
  useGovernanceProfileQuery: () => mockProfile(),
  useAuditChainQuery: (_roomId: string, enabled: boolean) => mockAudit(enabled),
  useRoomReadinessQuery: () => ({
    isLoading: false,
    isError: false,
    data: {
      room_id: 'r1',
      current_mode: 'testnet',
      target_mode: 'capped_production',
      ready: false,
      unmet: [],
      items: [],
    },
  }),
  useModeTransitionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const mockFreeze = vi.fn();
vi.mock('../../lib/treasury-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/treasury-api.js')>()),
  setGovernanceFreeze: (...args: unknown[]) => mockFreeze(...args),
}));

import { GovernanceLifecyclePanel } from './GovernanceLifecyclePanel.js';

function profileData(over: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    data: {
      profile: {
        room_id: '22222222-2222-4222-8222-222222222222',
        governance_mode: 'testnet',
        law_pack_id: null,
        charter_version_id: null,
        treasury_id: null,
        freeze_state: 'active',
        freeze_reason: null,
        pause_flags: { deposits: false, proposals: false, executions: false },
        updated_at: '2026-07-01T00:00:00.000Z',
        ...over,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAudit.mockReturnValue({ data: undefined, isFetching: false, refetch: vi.fn() });
});

describe('GovernanceLifecyclePanel (WS-M.1/6)', () => {
  it('shows the mode with its description and the readiness checklist', async () => {
    mockProfile.mockReturnValue(profileData());
    const { container } = render(<GovernanceLifecyclePanel roomId="r1" isRoomSteward={false} />);
    expect(screen.getByText('Testnet')).toBeInTheDocument();
    expect(screen.getByText(/worthless test tokens/i)).toBeInTheDocument();
    expect(screen.getByText(/lifecycle readiness/i)).toBeInTheDocument();
    // Non-steward: no freeze form.
    expect(screen.queryByRole('button', { name: /freeze governance/i })).not.toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('lets a steward freeze with a recorded reason', async () => {
    mockProfile.mockReturnValue(profileData());
    mockFreeze.mockResolvedValue({ freeze_state: 'frozen' });
    render(<GovernanceLifecyclePanel roomId="r1" isRoomSteward />);
    const button = screen.getByRole('button', { name: /freeze governance now/i });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.change(screen.getByLabelText(/reason \(recorded in the audit chain\)/i), {
      target: { value: 'Suspicious proposal cluster.' },
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(mockFreeze).toHaveBeenCalledWith('r1', {
        action: 'freeze',
        scope: 'room',
        source: 'steward',
        reason: 'Suspicious proposal cluster.',
      }),
    );
  });

  it('tells a steward that only the platform can unfreeze', () => {
    mockProfile.mockReturnValue(profileData({ freeze_state: 'frozen' }));
    render(<GovernanceLifecyclePanel roomId="r1" isRoomSteward />);
    expect(screen.getByText(/only platform stewards can lift a freeze/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /freeze governance now/i }),
    ).not.toBeInTheDocument();
  });

  it('verifies the audit chain on demand and surfaces problems', async () => {
    mockProfile.mockReturnValue(profileData());
    mockAudit.mockImplementation((enabled: boolean) =>
      enabled
        ? {
            data: {
              valid: false,
              chained_entries: 41,
              problems: ['entry e-9: stored hash does not recompute (tamper evidence)'],
            },
            isFetching: false,
            refetch: vi.fn(),
          }
        : { data: undefined, isFetching: false, refetch: vi.fn() },
    );
    render(<GovernanceLifecyclePanel roomId="r1" isRoomSteward={false} />);
    fireEvent.click(screen.getByRole('button', { name: /verify the audit chain/i }));
    await waitFor(() => expect(screen.getByText(/integrity problems found/i)).toBeInTheDocument());
    expect(screen.getByText(/tamper evidence/i)).toBeInTheDocument();
  });
});
