// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U "How this room is governed" panel (SPEC §16.6, §24.6). The in-room
// transparency surface: whether a community-approved AI agent governs the room,
// the powers the community granted it, the member-downloadable model artifact
// (the accountability core), and the recent agent actions (each appealable to the
// platform's human stewards — the non-overridable legal floor). Read-only; the
// steward's propose/approve powers live elsewhere. No applause primitives.

import { useState } from 'react';
import { useT } from '../../i18n/index.js';
import { ApiClientError } from '../../lib/api.js';
import { downloadGovernanceModel } from '../../lib/governance-api.js';
import { downloadModelBundle } from '../../lib/governance-download.js';
import { useGovernedByQuery } from '../../lib/queries.js';
import { Badge } from '../ui/Badge/index.js';
import { Button } from '../ui/Button/index.js';
import { Card } from '../ui/Card/index.js';
import { ErrorState } from '../ui/ErrorState/index.js';
import { LoadingState } from '../ui/LoadingState/index.js';

/** Human-readable labels for the granted agent capabilities. */
const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  'moderate.flag': 'Flag for human review',
  'moderate.warn': 'Warn',
  'moderate.restrict': 'Limit visibility',
  'moderate.remove': 'Remove content',
  'moderate.restore': 'Restore content',
  'lawmaking.summarize': 'Summarize proposals',
  'lawmaking.schedule': 'Schedule community decisions',
  'lawmaking.attest': 'Attest outcomes',
  'treasury.report': 'Publish treasury reports',
  'treasury.distribute': 'Member distributions',
  'treasury.grant': 'Grants',
  'treasury.invest': 'Treasury investment',
  'gateway.submit_signed_action': 'Submit treasury actions',
};

function capabilityLabel(t: ReturnType<typeof useT>, capability: string): string {
  return t(`room.governance.capability.${capability}`, CAPABILITY_LABELS[capability] ?? capability);
}

export interface GovernedByPanelProps {
  roomId: string;
  /** Defer the fetch until the reader has passed the room's read bar. */
  enabled?: boolean;
  /** Render inside the governance modal's tab: no card chrome or duplicate
   *  heading (the modal title + tab supply the section name). */
  embedded?: boolean;
}

export function GovernedByPanel({
  roomId,
  enabled = true,
  embedded = false,
}: GovernedByPanelProps): React.ReactElement {
  const t = useT();
  const query = useGovernedByQuery(roomId, enabled);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function handleDownload(modelId: string): Promise<void> {
    setDownloadError(null);
    try {
      downloadModelBundle(await downloadGovernanceModel(roomId, modelId));
    } catch (e) {
      setDownloadError(
        e instanceof ApiClientError
          ? e.message
          : t('room.governance.download.error', 'Could not download the model.'),
      );
    }
  }

  const content = (
    <>
      {query.isLoading ? (
        <LoadingState label={t('room.governance.loading', 'Loading room governance')} />
      ) : query.isError || !query.data ? (
        <ErrorState
          title={t('room.governance.error.title', "Couldn't load room governance")}
          description={t(
            'room.governance.error.desc',
            'The governance view is unavailable right now.',
          )}
        />
      ) : query.data.frozen ? (
        <div className="mt-2 flex flex-col gap-2">
          <Badge tone="warning">
            {t('room.governance.frozen.badge', 'Agent paused by the platform floor')}
          </Badge>
          <p className="text-sm text-ink-muted">
            {t(
              'room.governance.frozen.body',
              "A community-approved AI agent governs this room, but Licio's platform stewards — the non-overridable legal floor — have paused it. The room runs on the platform moderation baseline until the floor restores the agent.",
            )}
          </p>
        </div>
      ) : !query.data.active ? (
        <p className="mt-2 text-sm text-ink-muted">
          {t(
            'room.governance.baseline',
            "This room runs on Licio's platform moderation baseline. Any member can propose an AI model for the room; the community votes on it, and an elected steward validates the process. An approved model moderates the room within community-voted, kernel-enforced limits.",
          )}
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="info">{t('room.governance.active.badge', 'Community-governed')}</Badge>
            {query.data.model_id ? (
              <Button
                variant="ghost"
                onClick={() => {
                  if (query.data.model_id) void handleDownload(query.data.model_id);
                }}
              >
                {t('room.governance.download', 'Download the governing model')}
              </Button>
            ) : null}
          </div>

          {downloadError ? <p className="text-error-on-soft text-xs">{downloadError}</p> : null}

          <p className="text-sm text-ink-muted">
            {t(
              'room.governance.active.body',
              "An elected community has approved an in-room AI agent. It acts only within powers the community granted, holds no keys, and every action is appealable to Licio's human stewards — the platform's non-overridable legal floor.",
            )}
          </p>

          <div>
            <h3 className="text-sm font-medium">
              {t('room.governance.models.heading', 'Models governing this room')}
            </h3>
            <ul
              className="mt-1 flex flex-col gap-1 text-sm"
              aria-label={t('room.governance.models.label', 'Per-role governing models')}
            >
              {(
                [
                  ['moderation', t('room.governance.models.moderation', 'Moderation')],
                  ['adjudication', t('room.governance.models.adjudication', 'Adjudication')],
                ] as const
              ).map(([role, label]) => {
                const ref = query.data.model_selection?.[role] ?? null;
                return (
                  <li key={role} className="flex flex-wrap items-center gap-2">
                    <span className="text-ink-muted">{label}:</span>
                    {ref ? (
                      <>
                        <span className="font-mono text-xs">{ref.repo_id}</span>
                        <Badge tone="info">
                          {t('room.governance.models.pinned', 'pinned')} {ref.revision.slice(0, 12)}
                        </Badge>
                        {ref.served_model_id ? (
                          // A runtime id differing from the verified repo is
                          // surfaced, never hidden behind the repo id.
                          <Badge tone="neutral">
                            {t('room.governance.models.servedAs', 'served as')}{' '}
                            {ref.served_model_id}
                          </Badge>
                        ) : null}
                      </>
                    ) : (
                      <span>
                        {t('room.governance.models.platformDefault', 'Platform default model')}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <div>
            <h3 className="text-sm font-medium">
              {t('room.governance.powers.heading', 'Powers the community granted')}
            </h3>
            {query.data.granted.length === 0 ? (
              <p className="mt-1 text-sm text-ink-muted">
                {t('room.governance.powers.none', 'None.')}
              </p>
            ) : (
              <ul
                className="mt-1 flex flex-wrap gap-2"
                aria-label={t('room.governance.powers.label', 'Granted agent powers')}
              >
                {query.data.granted.map((capability) => (
                  <li key={capability}>
                    <Badge tone="neutral">{capabilityLabel(t, capability)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="text-sm font-medium">
              {t('room.governance.actions.heading', 'Recent agent actions')}
            </h3>
            {query.data.recent_actions.length === 0 ? (
              <p className="mt-1 text-sm text-ink-muted">
                {t(
                  'room.governance.actions.none',
                  'The agent has taken no moderation actions yet.',
                )}
              </p>
            ) : (
              <ul className="mt-1 flex flex-col gap-2">
                {query.data.recent_actions.map((action) => (
                  <li key={action.action_id} className="neu-inset rounded-lg p-3 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge tone="neutral">{action.action_type}</Badge>
                      {!action.reversible ? (
                        <Badge tone="warning">
                          {t('room.governance.actions.irreversible', 'Irreversible')}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-ink-muted">{action.statement_of_reasons}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );

  if (embedded) {
    return <div className="flex flex-col gap-2">{content}</div>;
  }

  return (
    <Card as="section">
      <h2 className="text-base font-semibold">
        {t('room.governance.heading', 'How this room is governed')}
      </h2>
      {content}
    </Card>
  );
}
