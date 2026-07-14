// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.1.2e — the readiness checklist: per-item pass/fail/not-applicable with
// required-for chips, the steward transition form (reason required), and a
// blocked transition surfacing the server's LIVE unmet list.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModeTransitionBlockedError } from '../../lib/treasury-api.js';
import { checkA11y } from '../../test/axe.js';

const mockReadiness = vi.fn();
const mockMutateAsync = vi.fn();
vi.mock('../../lib/queries.js', () => ({
  useRoomReadinessQuery: () => mockReadiness(),
  useModeTransitionMutation: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}));

import { ReadinessChecklist } from './ReadinessChecklist.js';

const ITEMS = [
  {
    requirement: 'comprehension_passed',
    status: 'pass' as const,
    description: 'The steward has passed the comprehension check.',
    required_for: ['testnet' as const],
    evaluated_at: '2026-07-01T00:00:00.000Z',
  },
  {
    requirement: 'external_audit_passed',
    status: 'fail' as const,
    description: 'An external audit attestation is required.',
    required_for: ['mature_production' as const],
    evaluated_at: '2026-07-01T00:00:00.000Z',
  },
  {
    requirement: 'governance_model_ratified',
    status: 'not_applicable' as const,
    description: 'No in-room AI agent is proposed.',
    required_for: [],
    evaluated_at: '2026-07-01T00:00:00.000Z',
  },
];

function readinessData(over: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    isError: false,
    data: {
      room_id: 'r1',
      current_mode: 'simulated',
      target_mode: 'testnet',
      ready: false,
      unmet: [{ requirement: 'external_audit_passed', description: 'Audit missing.' }],
      items: ITEMS,
      ...over,
    },
  };
}

beforeEach(() => {
  mockReadiness.mockReset();
  mockMutateAsync.mockReset();
});

describe('ReadinessChecklist (WS-M.1.2e)', () => {
  it('renders every item with its status and required-for modes', async () => {
    mockReadiness.mockReturnValue(readinessData());
    const { container } = render(<ReadinessChecklist roomId="r1" isRoomSteward={false} />);
    expect(screen.getByText('Met')).toBeInTheDocument();
    expect(screen.getByText('Not met')).toBeInTheDocument();
    expect(screen.getByText('Not applicable')).toBeInTheDocument();
    expect(screen.getByText(/external audit attestation is required/i)).toBeInTheDocument();
    expect(screen.getByText(/not ready yet/i)).toBeInTheDocument();
    // A failing item names the mode that needs it.
    expect(screen.getByText(/mature production/i)).toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('hides the transition form from non-stewards', () => {
    mockReadiness.mockReturnValue(readinessData());
    render(<ReadinessChecklist roomId="r1" isRoomSteward={false} />);
    expect(screen.queryByRole('button', { name: /request transition/i })).not.toBeInTheDocument();
  });

  it('requires a reason before a steward can request the transition', () => {
    mockReadiness.mockReturnValue(readinessData());
    render(<ReadinessChecklist roomId="r1" isRoomSteward />);
    const button = screen.getByRole('button', { name: /request transition/i });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.change(screen.getByLabelText(/reason for the transition/i), {
      target: { value: 'Track record complete.' },
    });
    expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('submits the transition with the evaluated target mode and the reason', async () => {
    mockReadiness.mockReturnValue(readinessData({ ready: true, unmet: [] }));
    mockMutateAsync.mockResolvedValue({ governance_mode: 'testnet' });
    render(<ReadinessChecklist roomId="r1" isRoomSteward />);
    fireEvent.change(screen.getByLabelText(/reason for the transition/i), {
      target: { value: 'Ready to escalate.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /request transition/i }));
    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({
        target_mode: 'testnet',
        reason: 'Ready to escalate.',
      }),
    );
  });

  it('surfaces the live unmet list when the gate blocks the transition', async () => {
    mockReadiness.mockReturnValue(readinessData());
    mockMutateAsync.mockRejectedValue(
      new ModeTransitionBlockedError('not_ready', 'Readiness requirements are unmet.', [
        { requirement: 'external_audit_passed', description: 'The audit attestation is missing.' },
      ]),
    );
    render(<ReadinessChecklist roomId="r1" isRoomSteward />);
    fireEvent.change(screen.getByLabelText(/reason for the transition/i), {
      target: { value: 'Try anyway.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /request transition/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/requirements are unmet/i)).toBeInTheDocument();
    expect(screen.getByText(/audit attestation is missing/i)).toBeInTheDocument();
  });
});
