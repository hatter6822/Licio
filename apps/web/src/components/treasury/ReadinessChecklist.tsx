// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.1.2e — the member-visible readiness checklist + the steward's mode
// transition request.  The checklist is evaluated LIVE server-side for a
// chosen target mode: every item shows pass / fail / not-applicable plus the
// modes it is required for, so a room can see exactly what stands between it
// and the next lifecycle step.  A blocked transition surfaces the server's
// live unmet list (never a client guess).

import { READINESS_TARGET_MODES } from '@licio/shared';
import { useState } from 'react';
import { useT } from '../../i18n/index.js';
import { ApiClientError } from '../../lib/api.js';
import { useModeTransitionMutation, useRoomReadinessQuery } from '../../lib/queries.js';
import { ModeTransitionBlockedError } from '../../lib/treasury-api.js';
import { Badge } from '../ui/Badge/index.js';
import { Button } from '../ui/Button/index.js';
import { ErrorState } from '../ui/ErrorState/index.js';
import { LoadingState } from '../ui/LoadingState/index.js';
import { Select } from '../ui/Select/index.js';
import { TextArea } from '../ui/TextArea/index.js';
import { ComprehensionQuiz } from './ComprehensionQuiz.js';
import { governanceModeMeta } from './mode-meta.js';

const STATUS_TONE = { pass: 'success', fail: 'warning', not_applicable: 'neutral' } as const;

export interface ReadinessChecklistProps {
  roomId: string;
  /** Steward-only: show the transition request form. */
  isRoomSteward: boolean;
  enabled?: boolean;
}

export function ReadinessChecklist({
  roomId,
  isRoomSteward,
  enabled = true,
}: ReadinessChecklistProps): React.ReactElement {
  const t = useT();
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [transitionError, setTransitionError] = useState<{
    message: string;
    unmet: ReadonlyArray<{ requirement: string; description: string }>;
  } | null>(null);
  const readiness = useRoomReadinessQuery(roomId, target, enabled);
  const transition = useModeTransitionMutation(roomId);

  const targetOptions = READINESS_TARGET_MODES.map((mode) => ({
    value: mode,
    label: t(`room.governance.mode.${mode}`, governanceModeMeta(mode).label),
  }));

  async function handleTransition(): Promise<void> {
    const data = readiness.data;
    if (data?.target_mode === undefined || reason.trim() === '') return;
    setTransitionError(null);
    try {
      await transition.mutateAsync({ target_mode: data.target_mode, reason: reason.trim() });
      setReason('');
    } catch (e) {
      if (e instanceof ModeTransitionBlockedError) {
        setTransitionError({ message: e.message, unmet: e.unmet });
      } else {
        setTransitionError({
          message:
            e instanceof ApiClientError
              ? e.message
              : t('room.readiness.transition.error', 'The transition request failed.'),
          unmet: [],
        });
      }
    }
  }

  if (readiness.isLoading) {
    return <LoadingState label={t('room.readiness.loading', 'Loading readiness checklist')} />;
  }
  if (readiness.isError || !readiness.data) {
    return (
      <ErrorState
        title={t('room.readiness.error.title', "Couldn't load the readiness checklist")}
        description={t('room.readiness.error.desc', 'The checklist is unavailable right now.')}
      />
    );
  }
  const data = readiness.data;
  const items = data.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label={t('room.readiness.target.label', 'Readiness for')}
          value={data.target_mode ?? targetOptions[0]?.value ?? ''}
          onValueChange={(value) => setTarget(value)}
          options={targetOptions}
          className="min-w-48"
        />
        <Badge tone={data.ready ? 'success' : 'warning'}>
          {data.ready
            ? t('room.readiness.ready', 'Ready')
            : t('room.readiness.notReady', 'Not ready yet')}
        </Badge>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {t('room.readiness.legacy', 'Per-item detail is unavailable; unmet requirements:')}{' '}
          {data.unmet.length === 0
            ? t('room.readiness.none', 'none.')
            : data.unmet.map((u) => u.description).join(' ')}
        </p>
      ) : (
        <ul
          className="flex flex-col gap-2"
          aria-label={t('room.readiness.items.label', 'Readiness requirements')}
        >
          {items.map((item) => (
            <li key={item.requirement} className="neu-inset rounded-lg p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS_TONE[item.status]}>
                  {item.status === 'pass'
                    ? t('room.readiness.status.pass', 'Met')
                    : item.status === 'fail'
                      ? t('room.readiness.status.fail', 'Not met')
                      : t('room.readiness.status.na', 'Not applicable')}
                </Badge>
                <span className="font-medium">{item.requirement.replaceAll('_', ' ')}</span>
              </div>
              <p className="mt-1 text-ink-muted">{item.description}</p>
              {item.required_for.length > 0 ? (
                <p className="mt-1 text-xs text-ink-muted">
                  {t('room.readiness.requiredFor', 'Required for:')}{' '}
                  {item.required_for
                    .map((mode) =>
                      t(`room.governance.mode.${mode}`, governanceModeMeta(mode).label),
                    )
                    .join(', ')}
                </p>
              ) : null}
              {/* The one requirement the reader can satisfy from HERE. Every other
                  item is a room fact (charter, stewards, treasury policy, track
                  record) settled elsewhere, but the comprehension check is a
                  personal action — listing it as "not met" with no way to take it
                  is a dead end, so the quiz opens in place (WS-L.4.1e).  Rendered
                  only while the requirement is UNMET: once it passes the badge
                  already says so, and mounting the quiz would just re-fetch it. */}
              {item.requirement === 'comprehension_passed' && item.status === 'fail' ? (
                <div className="mt-3 border-t border-line pt-3">
                  <ComprehensionQuiz roomId={roomId} enabled={enabled} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {isRoomSteward ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void handleTransition();
          }}
        >
          <TextArea
            label={t('room.readiness.reason.label', 'Reason for the transition request')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            maxLength={1000}
            required
          />
          <div>
            <Button type="submit" disabled={transition.isPending || reason.trim() === ''}>
              {t('room.readiness.transition.button', 'Request transition to {mode}', {
                mode: t(
                  `room.governance.mode.${data.target_mode ?? ''}`,
                  governanceModeMeta(data.target_mode ?? '').label,
                ),
              })}
            </Button>
          </div>
          {transitionError ? (
            <div role="alert" className="text-sm text-error-fg">
              <p>{transitionError.message}</p>
              {transitionError.unmet.length > 0 ? (
                <ul className="mt-1 list-disc pl-5">
                  {transitionError.unmet.map((u) => (
                    <li key={u.requirement}>{u.description}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
