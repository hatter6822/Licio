// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.4.1e — the simulation-comprehension check.  `comprehension_passed` is a
// HARD readiness requirement for `simulated → testnet`, so this surface is the
// only way a steward can satisfy it; these tests pin that it grades, teaches on
// a wrong answer, and never claims a pass the server did not grant.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../test/axe.js';

const mockQuiz = vi.fn();
const mockMutateAsync = vi.fn();
vi.mock('../../lib/queries.js', () => ({
  useComprehensionQuizQuery: () => mockQuiz(),
  useSubmitComprehensionMutation: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}));

import { ComprehensionQuiz } from './ComprehensionQuiz.js';

const QUESTIONS = [
  {
    question_id: 'q1',
    prompt: 'What does simulation mode move?',
    choices: ['Real funds', 'No real funds'],
    explanation: 'Simulation never moves real assets.',
  },
  {
    question_id: 'q2',
    prompt: 'Who may overrule the room?',
    choices: ['Nobody', 'The platform safety floor'],
    explanation: 'The platform floor always prevails.',
  },
];

function quizData(over: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    isError: false,
    data: { quiz_version: 'v1', questions: QUESTIONS, already_passed: false, ...over },
  };
}

beforeEach(() => {
  mockQuiz.mockReset();
  mockMutateAsync.mockReset();
});

describe('ComprehensionQuiz (WS-L.4.1e)', () => {
  it('renders every question as a labelled radio group with no axe violations', async () => {
    mockQuiz.mockReturnValue(quizData());
    const { container } = render(<ComprehensionQuiz roomId="r1" />);
    expect(screen.getByText(/1\. What does simulation mode move\?/)).toBeInTheDocument();
    expect(screen.getByText(/2\. Who may overrule the room\?/)).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  // A partially-answered quiz cannot be graded, so submitting is blocked rather
  // than sending an incomplete map the server would reject.
  it('requires every question to be answered before submitting', () => {
    mockQuiz.mockReturnValue(quizData());
    render(<ComprehensionQuiz roomId="r1" />);
    const submit = screen.getByRole('button', { name: /submit answers/i });
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getAllByRole('radio')[0] as HTMLElement);
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getAllByRole('radio')[3] as HTMLElement);
    expect(submit).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('submits the chosen answers against the served quiz version', async () => {
    mockQuiz.mockReturnValue(quizData());
    mockMutateAsync.mockResolvedValue({ passed: true, corrections: [] });
    render(<ComprehensionQuiz roomId="r1" />);
    fireEvent.click(screen.getAllByRole('radio')[1] as HTMLElement);
    fireEvent.click(screen.getAllByRole('radio')[3] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /submit answers/i }));
    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({
        quiz_version: 'v1',
        answers: { q1: 1, q2: 1 },
      }),
    );
    await waitFor(() => expect(screen.getByText('Passed')).toBeInTheDocument());
  });

  // A wrong answer comes back with the correct choice AND the reason: the check
  // is meant to teach the simulation boundary, not merely gate on it.
  it('shows the correct choice and explanation for each wrong answer', async () => {
    mockQuiz.mockReturnValue(quizData());
    mockMutateAsync.mockResolvedValue({
      passed: false,
      corrections: [
        {
          question_id: 'q1',
          correct_choice: 1,
          explanation: 'Simulation never moves real assets.',
        },
      ],
    });
    render(<ComprehensionQuiz roomId="r1" />);
    fireEvent.click(screen.getAllByRole('radio')[0] as HTMLElement);
    fireEvent.click(screen.getAllByRole('radio')[3] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /submit answers/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/Correct answer:\s*No real funds/)).toBeInTheDocument();
    expect(screen.getByText('Simulation never moves real assets.')).toBeInTheDocument();
    expect(screen.getByText(/review the explanations above/i)).toBeInTheDocument();
    // Never a false "Passed" on a failing grade.
    expect(screen.queryByText('Passed')).not.toBeInTheDocument();
  });

  it('reports the already-passed state instead of re-asking', () => {
    mockQuiz.mockReturnValue(quizData({ already_passed: true }));
    render(<ComprehensionQuiz roomId="r1" />);
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  // A failed SUBMIT is not a failed grade: it must not read as "not quite".
  it('surfaces a submit error without claiming a grade', async () => {
    mockQuiz.mockReturnValue(quizData());
    mockMutateAsync.mockRejectedValue(new Error('offline'));
    render(<ComprehensionQuiz roomId="r1" />);
    fireEvent.click(screen.getAllByRole('radio')[0] as HTMLElement);
    fireEvent.click(screen.getAllByRole('radio')[2] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /submit answers/i }));
    await waitFor(() =>
      expect(screen.getByText('We could not record your answers.')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/review the explanations above/i)).not.toBeInTheDocument();
  });

  it('shows the loading and error states', () => {
    mockQuiz.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    const loading = render(<ComprehensionQuiz roomId="r1" />);
    expect(screen.getByText(/loading the comprehension check/i)).toBeInTheDocument();
    loading.unmount();
    mockQuiz.mockReturnValue({ isLoading: false, isError: true, data: undefined });
    render(<ComprehensionQuiz roomId="r1" />);
    expect(screen.getByText(/couldn't load the comprehension check/i)).toBeInTheDocument();
  });
});
