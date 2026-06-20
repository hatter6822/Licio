// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U "How this room is governed" panel (SPEC §16.6, §24.6). The in-room
// transparency surface: whether a community-approved AI agent governs the room,
// the powers the community granted it, the member-downloadable model artifact
// (the accountability core), and the recent agent actions (each appealable to the
// platform's human stewards — the non-overridable legal floor). Read-only; the
// steward's propose/approve powers live elsewhere. No applause primitives.

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

function capabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? capability;
}

export interface GovernedByPanelProps {
  roomId: string;
  /** Defer the fetch until the reader has passed the room's read bar. */
  enabled?: boolean;
}

export function GovernedByPanel({
  roomId,
  enabled = true,
}: GovernedByPanelProps): React.ReactElement {
  const query = useGovernedByQuery(roomId, enabled);

  async function handleDownload(modelId: string): Promise<void> {
    downloadModelBundle(await downloadGovernanceModel(roomId, modelId));
  }

  return (
    <Card as="section">
      <h2 className="text-base font-semibold">How this room is governed</h2>

      {query.isLoading ? (
        <LoadingState label="Loading room governance" />
      ) : query.isError || !query.data ? (
        <ErrorState
          title="Couldn't load room governance"
          description="The governance view is unavailable right now."
        />
      ) : query.data.frozen ? (
        <div className="mt-2 flex flex-col gap-2">
          <Badge tone="warning">Agent paused by the platform floor</Badge>
          <p className="text-sm text-ink-muted">
            A community-approved AI agent governs this room, but Licio's platform stewards — the
            non-overridable legal floor — have paused it. The room runs on the platform moderation
            baseline until the floor restores the agent.
          </p>
        </div>
      ) : !query.data.active ? (
        <p className="mt-2 text-sm text-ink-muted">
          This room runs on Licio's platform moderation baseline. Members can elect a steward to
          propose a community-approved AI model that moderates the room within community-voted,
          kernel-enforced limits.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="info">Community-governed</Badge>
            {query.data.model_id ? (
              <Button
                variant="ghost"
                onClick={() => {
                  if (query.data.model_id) void handleDownload(query.data.model_id);
                }}
              >
                Download the governing model
              </Button>
            ) : null}
          </div>

          <p className="text-sm text-ink-muted">
            An elected community has approved an in-room AI agent. It acts only within powers the
            community granted, holds no keys, and every action is appealable to Licio's human
            stewards — the platform's non-overridable legal floor.
          </p>

          <div>
            <h3 className="text-sm font-medium">Powers the community granted</h3>
            {query.data.granted.length === 0 ? (
              <p className="mt-1 text-sm text-ink-muted">None.</p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-2" aria-label="Granted agent powers">
                {query.data.granted.map((capability) => (
                  <li key={capability}>
                    <Badge tone="neutral">{capabilityLabel(capability)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="text-sm font-medium">Recent agent actions</h3>
            {query.data.recent_actions.length === 0 ? (
              <p className="mt-1 text-sm text-ink-muted">
                The agent has taken no moderation actions yet.
              </p>
            ) : (
              <ul className="mt-1 flex flex-col gap-2">
                {query.data.recent_actions.map((action) => (
                  <li key={action.action_id} className="neu-inset rounded-lg p-3 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge tone="neutral">{action.action_type}</Badge>
                      {!action.reversible ? <Badge tone="warning">Irreversible</Badge> : null}
                    </div>
                    <p className="mt-1 text-ink-muted">{action.statement_of_reasons}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
