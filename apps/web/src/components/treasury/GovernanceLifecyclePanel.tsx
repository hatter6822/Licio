// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.1 — the "Mode & readiness" tab: the server-derived mode indicator with
// its plain-language description, the live readiness checklist + steward
// transition request, the steward emergency freeze (unfreeze is platform-only,
// WS-M.2.4a — the UI says so instead of pretending), and the on-demand
// audit-chain integrity verification (WS-M.6.1: anyone can check that the
// room's governance history recomputes end to end).

import { useState } from 'react';
import { useT } from '../../i18n/index.js';
import { ApiClientError } from '../../lib/api.js';
import { useAuditChainQuery, useGovernanceProfileQuery } from '../../lib/queries.js';
import { setGovernanceFreeze } from '../../lib/treasury-api.js';
import { Badge } from '../ui/Badge/index.js';
import { Button } from '../ui/Button/index.js';
import { TextArea } from '../ui/TextArea/index.js';
import { GovernanceModeBadge } from './GovernanceModeBadge.js';
import { ReadinessChecklist } from './ReadinessChecklist.js';

function AuditIntegritySection({ roomId }: { roomId: string }): React.ReactElement {
  const t = useT();
  const [requested, setRequested] = useState(false);
  const verification = useAuditChainQuery(roomId, requested);

  return (
    <section aria-label={t('room.audit.heading', 'Governance audit integrity')}>
      <h3 className="text-sm font-medium">
        {t('room.audit.heading', 'Governance audit integrity')}
      </h3>
      <p className="mt-1 text-xs text-ink-muted">
        {t(
          'room.audit.body',
          "Every governance action is hash-chained. Verification recomputes the room's whole chain server-side.",
        )}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          disabled={verification.isFetching}
          onClick={() => {
            setRequested(true);
            if (requested) void verification.refetch();
          }}
        >
          {t('room.audit.verify', 'Verify the audit chain')}
        </Button>
        {verification.data !== undefined ? (
          <Badge tone={verification.data.valid ? 'success' : 'error'}>
            {verification.data.valid
              ? t('room.audit.valid', '{count} entries verified', {
                  count: verification.data.chained_entries,
                })
              : t('room.audit.invalid', 'Integrity problems found')}
          </Badge>
        ) : null}
      </div>
      {verification.data !== undefined && verification.data.problems.length > 0 ? (
        <ul role="alert" className="mt-2 list-disc pl-5 text-sm text-error-fg">
          {verification.data.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function StewardFreezeSection({
  roomId,
  freezeState,
  onChanged,
}: {
  roomId: string;
  freezeState: string;
  onChanged: () => void;
}): React.ReactElement {
  const t = useT();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frozen = freezeState !== 'active';

  async function freeze(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await setGovernanceFreeze(roomId, {
        action: 'freeze',
        scope: 'room',
        source: 'steward',
        reason: reason.trim(),
      });
      setReason('');
      onChanged();
    } catch (e) {
      setError(
        e instanceof ApiClientError
          ? e.message
          : t('room.freeze.error', 'The freeze request failed.'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={t('room.freeze.heading', 'Emergency freeze')}>
      <h3 className="text-sm font-medium">{t('room.freeze.heading', 'Emergency freeze')}</h3>
      {frozen ? (
        <p className="mt-1 text-sm text-warning-fg">
          {t(
            'room.freeze.frozen',
            'Governance is frozen. Only platform stewards can lift a freeze (the non-overridable floor).',
          )}
        </p>
      ) : (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void freeze();
          }}
        >
          <TextArea
            label={t('room.freeze.reason', 'Reason (recorded in the audit chain)')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            maxLength={500}
            required
          />
          <div>
            <Button type="submit" variant="destructive" disabled={busy || reason.trim() === ''}>
              {t('room.freeze.button', 'Freeze governance now')}
            </Button>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-sm text-error-fg">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export interface GovernanceLifecyclePanelProps {
  roomId: string;
  isRoomSteward: boolean;
  enabled?: boolean;
}

export function GovernanceLifecyclePanel({
  roomId,
  isRoomSteward,
  enabled = true,
}: GovernanceLifecyclePanelProps): React.ReactElement {
  const t = useT();
  const profile = useGovernanceProfileQuery(roomId, enabled);

  return (
    <div className="flex flex-col gap-6">
      {profile.data !== undefined ? (
        <GovernanceModeBadge mode={profile.data.profile.governance_mode} showDescription />
      ) : null}

      <section aria-label={t('room.readiness.heading', 'Lifecycle readiness')}>
        <h3 className="mb-2 text-sm font-medium">
          {t('room.readiness.heading', 'Lifecycle readiness')}
        </h3>
        <ReadinessChecklist roomId={roomId} isRoomSteward={isRoomSteward} enabled={enabled} />
      </section>

      {isRoomSteward && profile.data !== undefined ? (
        <StewardFreezeSection
          roomId={roomId}
          freezeState={profile.data.profile.freeze_state}
          onChanged={() => void profile.refetch()}
        />
      ) : null}

      <AuditIntegritySection roomId={roomId} />
    </div>
  );
}
