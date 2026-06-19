// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U steward write surface: a non-steward with no proposals sees nothing; a
// member sees the read-only registry; the elected steward gets the propose form
// (with client-side JSON validation) and the guarded ratify action on an
// eligible model. Accessible; no applause primitives.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/auth.js';
import { checkA11y } from '../../test/axe.js';

const mockSeat = vi.hoisted(() => vi.fn());
const mockModels = vi.hoisted(() => vi.fn());
const proposeMutate = vi.hoisted(() => vi.fn());
const approveMutate = vi.hoisted(() => vi.fn());
const downloadModel = vi.hoisted(() => vi.fn());

vi.mock('../../lib/queries.js', () => ({
  useStewardSeatQuery: () => mockSeat(),
  useGovernanceModelsQuery: () => mockModels(),
  useProposeModelMutation: () => ({ mutate: proposeMutate, isPending: false }),
  useApproveModelMutation: () => ({ mutate: approveMutate, isPending: false }),
}));
vi.mock('../../lib/governance-api.js', () => ({ downloadGovernanceModel: downloadModel }));

import { StewardModelManager } from './StewardModelManager.js';

function seatHeldBy(userId: string | null): void {
  mockSeat.mockReturnValue({
    data: {
      seat:
        userId === null
          ? null
          : {
              room_id: 'r1',
              holder_user_id: userId,
              term_start: 't',
              term_end: 't',
              bootstrap: true,
              current_election_id: null,
            },
    },
  });
}

function modelsList(models: unknown[]): void {
  mockModels.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { steward_user_id: null, models },
  });
}

function eligibleModel(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_id: 'm1',
    artifact_digest: 'a'.repeat(64),
    status: 'eligible',
    proposed_by_user_id: 'steward-1',
    created_at: '2026-06-19T00:00:00.000Z',
    ...over,
  };
}

function signInAs(id: string): void {
  useAuthStore.setState({ status: 'authenticated', user: { id } } as never);
}

beforeEach(() => {
  mockSeat.mockReset();
  mockModels.mockReset();
  proposeMutate.mockReset();
  approveMutate.mockReset();
  downloadModel.mockReset();
  modelsList([]);
  seatHeldBy(null);
});

afterEach(() => {
  useAuthStore.setState({ status: 'unauthenticated', user: null } as never);
});

describe('StewardModelManager (WS-U §16.6)', () => {
  it('renders nothing for a non-steward with no proposals', () => {
    const { container } = render(<StewardModelManager roomId="r1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the registry (read-only) to a member once proposals exist', () => {
    seatHeldBy('someone-else');
    modelsList([eligibleModel()]);
    render(<StewardModelManager roomId="r1" />);
    expect(screen.getByText('Passed platform checks')).toBeInTheDocument();
    // A non-steward gets neither steward affordance.
    expect(screen.queryByRole('button', { name: /propose a model/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /adopt for the community/i }),
    ).not.toBeInTheDocument();
  });

  it('lets the elected steward propose a valid model + prompt', () => {
    proposeMutate.mockImplementation((_body: unknown, opts: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    );
    seatHeldBy('steward-1');
    signInAs('steward-1');
    render(<StewardModelManager roomId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /propose a model/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit proposal/i }));
    expect(proposeMutate).toHaveBeenCalledTimes(1);
    const body = proposeMutate.mock.calls[0]?.[0] as { bundle: unknown; prompt_text: string };
    // The bundle reaches the mutation parsed (an object), not as a raw string.
    expect(body.bundle).toMatchObject({ bundleId: 'starter-civility' });
    expect(typeof body.prompt_text).toBe('string');
  });

  it('rejects an invalid policy bundle client-side (no network call)', () => {
    seatHeldBy('steward-1');
    signInAs('steward-1');
    render(<StewardModelManager roomId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /propose a model/i }));
    fireEvent.change(screen.getByLabelText(/policy bundle/i), { target: { value: 'not json' } });
    fireEvent.click(screen.getByRole('button', { name: /submit proposal/i }));
    expect(screen.getByText(/must be valid json/i)).toBeInTheDocument();
    expect(proposeMutate).not.toHaveBeenCalled();
  });

  it('lets the steward adopt an eligible model after a confirm step', async () => {
    approveMutate.mockImplementation((_id: string, opts: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    );
    seatHeldBy('steward-1');
    signInAs('steward-1');
    modelsList([eligibleModel()]);
    const { container } = render(<StewardModelManager roomId="r1" />);
    // No direct one-click activation — a confirm step gates the ratification.
    fireEvent.click(screen.getByRole('button', { name: /adopt for the community/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm ratification/i }));
    expect(approveMutate).toHaveBeenCalledWith('m1', expect.anything());
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('shows the registry loading and error states to the steward', () => {
    seatHeldBy('steward-1');
    signInAs('steward-1');
    mockModels.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    const { rerender } = render(<StewardModelManager roomId="r1" />);
    expect(screen.getByText(/loading governance models/i)).toBeInTheDocument();
    mockModels.mockReturnValue({ isLoading: false, isError: true, data: undefined });
    rerender(<StewardModelManager roomId="r1" />);
    expect(screen.getByText(/couldn't load governance models/i)).toBeInTheDocument();
  });

  it('requires a prompt and surfaces a propose failure', () => {
    proposeMutate.mockImplementation((_b: unknown, opts: { onError?: (e: Error) => void }) =>
      opts?.onError?.(new Error('boom')),
    );
    seatHeldBy('steward-1');
    signInAs('steward-1');
    render(<StewardModelManager roomId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /propose a model/i }));
    // An empty prompt is rejected before any network call.
    fireEvent.change(screen.getByLabelText(/agent prompt/i), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /submit proposal/i }));
    expect(screen.getByText(/a prompt is required/i)).toBeInTheDocument();
    expect(proposeMutate).not.toHaveBeenCalled();
    // With a prompt restored, a server failure surfaces the fallback message.
    fireEvent.change(screen.getByLabelText(/agent prompt/i), { target: { value: 'be kind' } });
    fireEvent.click(screen.getByRole('button', { name: /submit proposal/i }));
    expect(screen.getByText(/could not propose the model/i)).toBeInTheDocument();
  });

  it('lets a member download any proposal to verify its digest', async () => {
    downloadModel.mockResolvedValue({
      model_id: 'm1',
      artifact_digest: 'a'.repeat(64),
      bundle: { name: 'Civility' },
    });
    const createObjectURL = vi.fn(() => 'blob:x');
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    seatHeldBy('someone-else');
    modelsList([eligibleModel()]);
    render(<StewardModelManager roomId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(downloadModel).toHaveBeenCalledWith('r1', 'm1'));
    expect(createObjectURL).toHaveBeenCalled();
  });

  it('cancels the propose form and a failed ratification', () => {
    approveMutate.mockImplementation((_id: string, opts: { onError?: (e: Error) => void }) =>
      opts?.onError?.(new Error('no')),
    );
    seatHeldBy('steward-1');
    signInAs('steward-1');
    modelsList([eligibleModel()]);
    render(<StewardModelManager roomId="r1" />);
    // Open then cancel the propose form.
    fireEvent.click(screen.getByRole('button', { name: /propose a model/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('button', { name: /submit proposal/i })).not.toBeInTheDocument();
    // A failed ratification surfaces an error; cancel returns to the adopt button.
    fireEvent.click(screen.getByRole('button', { name: /adopt for the community/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm ratification/i }));
    expect(screen.getByText(/could not record the ratification/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.getByRole('button', { name: /adopt for the community/i })).toBeInTheDocument();
  });
});
