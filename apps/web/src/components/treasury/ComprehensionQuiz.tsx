// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.4.1e — the simulation-comprehension check.
//
// `comprehension_passed` is a HARD readiness requirement for the
// `simulated → testnet` transition (`knomosis/readiness.ts`), and it is the
// third bot-prevention layer on a member's first governance action.  The
// checklist has always been able to report it as unmet; this is where a steward
// actually satisfies it.  Every question must be answered correctly to pass —
// a wrong answer comes back with the server's explanation and the correct
// choice, so the check teaches rather than merely gates.
//
// The correct answers never cross the wire on the READ (`quizQuestions()` strips
// `correctChoice`); they appear only in the graded response, so the quiz cannot
// be passed by reading the payload.

import type { ComprehensionSubmitResponse } from '@licio/shared';
import { useState } from 'react';
import { useT } from '../../i18n/index.js';
import { ApiClientError } from '../../lib/api.js';
import { useComprehensionQuizQuery, useSubmitComprehensionMutation } from '../../lib/queries.js';
import { Badge } from '../ui/Badge/index.js';
import { Button } from '../ui/Button/index.js';
import { ErrorState } from '../ui/ErrorState/index.js';
import { LoadingState } from '../ui/LoadingState/index.js';

export interface ComprehensionQuizProps {
  roomId: string;
  enabled?: boolean;
}

export function ComprehensionQuiz({
  roomId,
  enabled = true,
}: ComprehensionQuizProps): React.ReactElement {
  const t = useT();
  const quiz = useComprehensionQuizQuery(roomId, enabled);
  const submit = useSubmitComprehensionMutation(roomId);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<ComprehensionSubmitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (quiz.isLoading) {
    return (
      <LoadingState label={t('room.comprehension.loading', 'Loading the comprehension check')} />
    );
  }
  if (quiz.isError || !quiz.data) {
    return (
      <ErrorState
        title={t('room.comprehension.error.title', "Couldn't load the comprehension check")}
        description={t('room.comprehension.error.desc', 'It is unavailable right now.')}
      />
    );
  }

  const data = quiz.data;
  // Already passed — the requirement is satisfied for good; re-taking it would
  // only invite noise. (A new quiz VERSION resets this server-side.)
  if (data.already_passed || result?.passed === true) {
    return (
      <div className="flex items-center gap-2">
        <Badge tone="success">{t('room.comprehension.passed.badge', 'Passed')}</Badge>
        <p className="text-sm text-ink-muted">
          {t(
            'room.comprehension.passed',
            'You have passed the simulation-comprehension check for this room.',
          )}
        </p>
      </div>
    );
  }

  /** Corrections are keyed by question so each wrong answer explains itself in place. */
  const corrections = new Map((result?.corrections ?? []).map((c) => [c.question_id, c]));
  const allAnswered = data.questions.every((q) => answers[q.question_id] !== undefined);

  async function handleSubmit(): Promise<void> {
    setError(null);
    try {
      setResult(await submit.mutateAsync({ quiz_version: data.quiz_version, answers }));
    } catch (e) {
      setResult(null);
      setError(
        e instanceof ApiClientError
          ? e.message
          : t('room.comprehension.submitError', 'We could not record your answers.'),
      );
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <p className="text-sm text-ink-muted">
        {t(
          'room.comprehension.intro',
          'Answer every question correctly to satisfy the comprehension requirement for leaving simulation.',
        )}
      </p>

      {data.questions.map((question, index) => {
        const correction = corrections.get(question.question_id);
        const groupLabel = `${index + 1}. ${question.prompt}`;
        return (
          <fieldset key={question.question_id} className="neu-inset rounded-lg p-3">
            <legend className="px-1 text-sm font-medium text-ink">{groupLabel}</legend>
            <div className="mt-2 flex flex-col gap-2">
              {question.choices.map((choice, choiceIndex) => {
                const inputId = `${question.question_id}-${choiceIndex}`;
                return (
                  <label key={inputId} htmlFor={inputId} className="flex items-start gap-2 text-sm">
                    <input
                      id={inputId}
                      type="radio"
                      name={question.question_id}
                      className="mt-1 size-4"
                      checked={answers[question.question_id] === choiceIndex}
                      onChange={() =>
                        setAnswers((prev) => ({ ...prev, [question.question_id]: choiceIndex }))
                      }
                    />
                    <span>{choice}</span>
                  </label>
                );
              })}
            </div>
            {/* A wrong answer explains itself: the graded response carries the
                correct choice and the reason, so the check teaches. */}
            {correction ? (
              <div role="alert" className="mt-2 text-sm text-error-fg">
                <p>
                  {t('room.comprehension.correct', 'Correct answer:')}{' '}
                  {question.choices[correction.correct_choice] ?? ''}
                </p>
                <p className="text-ink-muted">{correction.explanation}</p>
              </div>
            ) : null}
          </fieldset>
        );
      })}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={submit.isPending || !allAnswered}>
          {t('room.comprehension.submit', 'Submit answers')}
        </Button>
        {!allAnswered ? (
          <p className="text-xs text-ink-muted">
            {t('room.comprehension.answerAll', 'Answer every question to submit.')}
          </p>
        ) : null}
      </div>

      {result && !result.passed ? (
        <p role="status" className="text-sm text-ink">
          {t(
            'room.comprehension.retry',
            'Not quite — review the explanations above and submit again.',
          )}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-error-fg">
          {error}
        </p>
      ) : null}
    </form>
  );
}
