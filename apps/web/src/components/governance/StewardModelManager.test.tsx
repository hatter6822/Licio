// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U steward write surface + member ratification voting: a non-steward with no
// proposals/vote sees nothing; a member sees the read-only registry; the elected
// steward gets the propose form and can open a ratification vote on an eligible
// model; when a vote is open, a member casts an approve/reject ballot while a
// non-member is prompted to join instead. Accessible; governance counts only
// (no applause primitives).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/auth.js';
import { checkA11y } from '../../test/axe.js';

const mockSeat = vi.hoisted(() => vi.fn());
const mockModels = vi.hoisted(() => vi.fn());
const mockRatification = vi.hoisted(() => vi.fn());
const proposeMutate = vi.hoisted(() => vi.fn());
const openVoteMutate = vi.hoisted(() => vi.fn());
const castMutate = vi.hoisted(() => vi.fn());
const downloadModel = vi.hoisted(() => vi.fn());

vi.mock('../../lib/queries.js', () => ({
  useStewardSeatQuery: () => mockSeat(),
  useGovernanceModelsQuery: () => mockModels(),
  useRatificationQuery: () => mockRatification(),
  useProposeModelMutation: () => ({ mutate: proposeMutate, isPending: false }),
  useOpenRatificationMutation: () => ({ mutate: openVoteMutate, isPending: false }),
  useCastBallotMutation: () => ({ mutate: castMutate, isPending: false }),
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
function openVote(vote: Record<string, unknown> | null): void {
  mockRatification.mockReturnValue({ isLoading: false, isError: false, data: { vote } });
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
  for (const m of [
    mockSeat,
    mockModels,
    mockRatification,
    proposeMutate,
    openVoteMutate,
    castMutate,
    downloadModel,
  ]) {
    m.mockReset();
  }
  modelsList([]);
  openVote(null);
  seatHeldBy(null);
});
afterEach(() => {
  useAuthStore.setState({ status: 'unauthenticated', user: null } as never);
});

describe('StewardModelManager (WS-U §16.6)', () => {
  it('renders nothing for a non-steward with no proposals and no open vote', () => {
    const { container } = render(<StewardModelManager roomId="r1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the registry (read-only) to a member once proposals exist', () => {
    seatHeldBy('someone-else');
    modelsList([eligibleModel()]);
    render(<StewardModelManager roomId="r1" />);
    expect(screen.getByText('Passed platform checks')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /propose a model/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /open ratification vote/i }),
    ).not.toBeInTheDocument();
  });

  it('lets the elected steward propose a valid model + prompt', () => {
    proposeMutate.mockImplementation((_b: unknown, opts: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    );
    seatHeldBy('steward-1');
    signInAs('steward-1');
    render(<StewardModelManager roomId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /propose a model/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit proposal/i }));
    expect(proposeMutate).toHaveBeenCalledTimes(1);
    const body = proposeMutate.mock.calls[0]?.[0] as { bundle: unknown; prompt_text: string };
    expect(body.bundle).toMatchObject({ bundleId: 'starter-civility' });
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

  it('lets the steward open a ratification vote on an eligible model', () => {
    seatHeldBy('steward-1');
    signInAs('steward-1');
    modelsList([eligibleModel()]);
    render(<StewardModelManager roomId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /open ratification vote/i }));
    expect(openVoteMutate).toHaveBeenCalledWith('m1', expect.anything());
  });

  it('hides the open-vote action once a vote is already open', () => {
    seatHeldBy('steward-1');
    signInAs('steward-1');
    modelsList([eligibleModel()]);
    openVote({
      vote_id: 'v1',
      model_id: 'm1',
      opens_at: '2026-06-19T00:00:00.000Z',
      closes_at: '2026-06-26T00:00:00.000Z',
      min_quorum: 1,
      in_favor: 0,
      opposed: 0,
    });
    render(<StewardModelManager roomId="r1" />);
    expect(
      screen.queryByRole('button', { name: /open ratification vote/i }),
    ).not.toBeInTheDocument();
  });

  it('lets a member cast an approve ballot on an open vote', async () => {
    castMutate.mockImplementation((_input: unknown, opts: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    );
    seatHeldBy('someone-else');
    signInAs('member-1');
    openVote({
      vote_id: 'v1',
      model_id: 'm1',
      opens_at: '2026-06-19T00:00:00.000Z',
      closes_at: '2026-06-26T00:00:00.000Z',
      min_quorum: 2,
      in_favor: 1,
      opposed: 0,
    });
    const { container } = render(<StewardModelManager roomId="r1" joined />);
    expect(screen.getByText(/ratification vote open/i)).toBeInTheDocument();
    expect(screen.getByText(/in favour: 1/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(castMutate).toHaveBeenCalledWith({ voteId: 'v1', choice: 'approve' }, expect.anything());
    await waitFor(() => expect(screen.getByText(/ballot is recorded/i)).toBeInTheDocument());
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('casts a reject ballot and surfaces a ballot failure', async () => {
    castMutate.mockImplementation((_input: unknown, opts: { onError?: (e: Error) => void }) =>
      opts?.onError?.(new Error('boom')),
    );
    seatHeldBy('someone-else');
    signInAs('member-1');
    openVote({
      vote_id: 'v1',
      model_id: 'm1',
      opens_at: '2026-06-19T00:00:00.000Z',
      closes_at: '2026-06-26T00:00:00.000Z',
      min_quorum: 2,
      in_favor: 0,
      opposed: 0,
    });
    render(<StewardModelManager roomId="r1" joined />);
    fireEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    expect(castMutate).toHaveBeenCalledWith({ voteId: 'v1', choice: 'reject' }, expect.anything());
    expect(screen.getByText(/could not record your ballot/i)).toBeInTheDocument();
  });

  it('asks a non-member to join instead of showing ballot buttons', () => {
    seatHeldBy('someone-else');
    signInAs('reader-1');
    openVote({
      vote_id: 'v1',
      model_id: 'm1',
      opens_at: '2026-06-19T00:00:00.000Z',
      closes_at: '2026-06-26T00:00:00.000Z',
      min_quorum: 2,
      in_favor: 0,
      opposed: 0,
    });
    // `joined` defaults to false: a signed-in non-member (not the steward).
    render(<StewardModelManager roomId="r1" />);
    expect(screen.getByText(/ratification vote open/i)).toBeInTheDocument();
    expect(screen.getByText(/join the room to take part in this vote/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
  });

  it('lets a room steward without a subscription cast a ballot (member via role)', () => {
    seatHeldBy('someone-else'); // not the elected seat holder
    signInAs('role-steward');
    openVote({
      vote_id: 'v1',
      model_id: 'm1',
      opens_at: '2026-06-19T00:00:00.000Z',
      closes_at: '2026-06-26T00:00:00.000Z',
      min_quorum: 2,
      in_favor: 0,
      opposed: 0,
    });
    // joined defaults false, but the viewer holds a steward role → isRoomMember.
    render(<StewardModelManager roomId="r1" isRoomSteward />);
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
    expect(screen.queryByText(/join the room to take part/i)).not.toBeInTheDocument();
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

  it('downloads any proposal to verify its digest', async () => {
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
});
