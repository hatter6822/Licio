// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U "governed by" transparency panel: renders the loading/error/inactive/
// active states, shows granted powers + recent agent actions, names the human
// floor-appeal path, and is accessible. No applause primitives.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadGovernanceModel } from '../../lib/governance-api.js';
import { checkA11y } from '../../test/axe.js';

const mockUseGovernedBy = vi.fn();
vi.mock('../../lib/queries.js', () => ({
  useGovernedByQuery: () => mockUseGovernedBy(),
}));
vi.mock('../../lib/governance-api.js', () => ({
  downloadGovernanceModel: vi.fn(),
}));

import { GovernedByPanel } from './GovernedByPanel.js';

describe('GovernedByPanel', () => {
  beforeEach(() => {
    mockUseGovernedBy.mockReset();
  });

  it('shows a loading state', () => {
    mockUseGovernedBy.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    render(<GovernedByPanel roomId="r1" />);
    expect(screen.getByText(/loading room governance/i)).toBeInTheDocument();
  });

  it('shows an error state', () => {
    mockUseGovernedBy.mockReturnValue({ isLoading: false, isError: true, data: undefined });
    render(<GovernedByPanel roomId="r1" />);
    expect(screen.getByText(/couldn't load room governance/i)).toBeInTheDocument();
  });

  it('explains the platform baseline when no agent governs the room', () => {
    mockUseGovernedBy.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { active: false, frozen: false, model_id: null, granted: [], recent_actions: [] },
    });
    render(<GovernedByPanel roomId="r1" />);
    expect(screen.getByText(/platform moderation baseline/i)).toBeInTheDocument();
  });

  it('shows a floor-paused state when a community agent is frozen', () => {
    mockUseGovernedBy.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { active: false, frozen: true, model_id: 'm-1', granted: [], recent_actions: [] },
    });
    render(<GovernedByPanel roomId="r1" />);
    expect(screen.getByText(/paused by the platform floor/i)).toBeInTheDocument();
    expect(screen.getByText(/non-overridable legal floor/i)).toBeInTheDocument();
  });

  it('renders the active agent, its granted powers, actions, and the floor-appeal path', async () => {
    mockUseGovernedBy.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        active: true,
        model_id: 'm-1',
        granted: ['moderate.remove', 'moderate.flag'],
        recent_actions: [
          {
            action_id: 'a-1',
            action_type: 'moderate.remove',
            subject_ref: 'c-1',
            statement_of_reasons: 'Removed for excessive links.',
            reversible: false,
            created_at: '2026-06-19T00:00:00.000Z',
          },
        ],
      },
    });
    const { container } = render(<GovernedByPanel roomId="r1" />);
    expect(screen.getByText('Community-governed')).toBeInTheDocument();
    expect(screen.getByText('Remove content')).toBeInTheDocument();
    expect(screen.getByText('Flag for human review')).toBeInTheDocument();
    expect(screen.getByText(/excessive links/i)).toBeInTheDocument();
    expect(screen.getByText('Irreversible')).toBeInTheDocument();
    // The non-overridable human floor is named.
    expect(screen.getByText(/human\s+stewards/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /download the governing model/i }),
    ).toBeInTheDocument();
    await checkA11y(container);
  });

  it('renders the embedded variant without the card heading (modal tab supplies it)', () => {
    mockUseGovernedBy.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { active: false, frozen: false, model_id: null, granted: [], recent_actions: [] },
    });
    render(<GovernedByPanel roomId="r1" embedded />);
    // The transparency content still renders…
    expect(screen.getByText(/platform moderation baseline/i)).toBeInTheDocument();
    // …but the standalone card heading is dropped (no duplicate section name).
    expect(
      screen.queryByRole('heading', { name: /how this room is governed/i }),
    ).not.toBeInTheDocument();
  });

  it('downloads the governing model on click', async () => {
    mockUseGovernedBy.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { active: true, model_id: 'm-1', granted: [], recent_actions: [] },
    });
    vi.mocked(downloadGovernanceModel).mockResolvedValue({
      model_id: 'm-1',
      artifact_digest: 'a'.repeat(64),
      bundle: { name: 'Civility' },
    });
    const createObjectURL = vi.fn(() => 'blob:x');
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    render(<GovernedByPanel roomId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /download the governing model/i }));
    await waitFor(() => expect(downloadGovernanceModel).toHaveBeenCalledWith('r1', 'm-1'));
    expect(createObjectURL).toHaveBeenCalled();
  });

  it('surfaces a download failure instead of an unhandled rejection', async () => {
    mockUseGovernedBy.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { active: true, model_id: 'm-1', granted: [], recent_actions: [] },
    });
    vi.mocked(downloadGovernanceModel).mockRejectedValue(new Error('network'));
    render(<GovernedByPanel roomId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /download the governing model/i }));
    await waitFor(() =>
      expect(screen.getByText(/could not download the model/i)).toBeInTheDocument(),
    );
  });
});
