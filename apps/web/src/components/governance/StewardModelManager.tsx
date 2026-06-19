// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U steward write surface (SPEC §16.6, §24.6). The elected room steward's two
// powers, and only those two: propose a community AI **model** (a declarative,
// member-downloadable GovernancePolicyBundle) and its **prompt**. The MEMBERS
// ratify by vote: once a proposal clears the platform admission gate the steward
// opens a ratification vote, and every member casts a yes/no ballot; the model
// activates only if the vote passes (settled by the scheduler at the window
// close). The registry (proposal pipeline + admission status) is shown to every
// member for transparency. No applause primitives; the vote shows governance
// counts (in favour / opposed), never a popularity signal.

import type { GovernanceModelSummary, RatificationViewResponse } from '@licio/shared';
import { useState } from 'react';
import { ApiClientError } from '../../lib/api.js';
import { downloadGovernanceModel } from '../../lib/governance-api.js';
import { downloadModelBundle } from '../../lib/governance-download.js';
import {
  useCastBallotMutation,
  useGovernanceModelsQuery,
  useOpenRatificationMutation,
  useProposeModelMutation,
  useRatificationQuery,
  useStewardSeatQuery,
} from '../../lib/queries.js';
import { useAuthStore } from '../../stores/index.js';
import { Badge, type BadgeTone } from '../ui/Badge/index.js';
import { Button } from '../ui/Button/index.js';
import { Card } from '../ui/Card/index.js';
import { ErrorState } from '../ui/ErrorState/index.js';
import { LoadingState } from '../ui/LoadingState/index.js';
import { TextArea } from '../ui/TextArea/index.js';

type OpenVote = NonNullable<RatificationViewResponse['vote']>;

/**
 * A valid starter policy bundle that passes the platform admission gate (it
 * flags clearly link-spammy content for human review without over-moderating a
 * benign comment). The steward edits this to express the community's policy.
 */
const STARTER_BUNDLE = `{
  "bundleId": "starter-civility",
  "version": "1",
  "name": "Starter civility policy",
  "moderationRules": [
    {
      "id": "link-spam",
      "when": { "kind": "link_count_gte", "value": 3 },
      "action": "flag_for_review",
      "reason": "Posts with several links are sent for human review."
    }
  ],
  "promptTemplates": { "summary": "Summarize the discussion neutrally and briefly." },
  "config": { "summaryStyle": "neutral_brief", "explanationVerbosity": "standard" },
  "requestedCapabilities": ["moderate.flag"]
}`;

const STARTER_PROMPT =
  'Be neutral and concise. When you act, cite the community rule that applies and never exceed the powers the community granted.';

/** Human-readable label + tone for each model lifecycle status. */
const STATUS_META: Readonly<
  Record<GovernanceModelSummary['status'], { label: string; tone: BadgeTone }>
> = {
  proposed: { label: 'Proposed', tone: 'neutral' },
  evaluating: { label: 'Checking against platform rules', tone: 'info' },
  eligible: { label: 'Passed platform checks', tone: 'info' },
  rejected: { label: 'Did not pass platform checks', tone: 'error' },
  approved: { label: 'Adopted by the community', tone: 'success' },
  superseded: { label: 'Superseded', tone: 'neutral' },
};

export interface StewardModelManagerProps {
  roomId: string;
  /** Defer the fetches until the reader has passed the room's read bar. */
  enabled?: boolean;
}

export function StewardModelManager({
  roomId,
  enabled = true,
}: StewardModelManagerProps): React.ReactElement | null {
  const seat = useStewardSeatQuery(roomId, enabled);
  const models = useGovernanceModelsQuery(roomId, enabled);
  const ratification = useRatificationQuery(roomId, enabled);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);

  const holder = seat.data?.seat?.holder_user_id ?? null;
  const isSteward = holder !== null && holder === currentUserId;
  const items = models.data?.models ?? [];
  const openVote = ratification.data?.vote ?? null;

  // Nothing to show until there's a proposal, an open vote, or a steward viewer.
  if (!isSteward && items.length === 0 && openVote === null) return null;

  return (
    <Card as="section">
      <h2 className="text-base font-semibold">Community governance models</h2>
      <p className="mt-1 text-sm text-ink-muted">
        The elected steward proposes an AI model and prompt; the community ratifies it by member
        vote. A model governs the room only within community-voted, kernel-enforced limits, and
        never below Licio's non-overridable platform floor.
      </p>

      {isSteward ? <ProposeForm roomId={roomId} /> : null}

      {openVote ? <RatificationVotePanel roomId={roomId} vote={openVote} /> : null}

      <div className="mt-4">
        <h3 className="text-sm font-medium">Proposals</h3>
        {models.isLoading ? (
          <LoadingState label="Loading governance models" />
        ) : models.isError ? (
          <ErrorState
            title="Couldn't load governance models"
            description="The model registry is unavailable right now."
          />
        ) : items.length === 0 ? (
          <p className="mt-1 text-sm text-ink-muted">No models have been proposed yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {items.map((model) => (
              <li key={model.model_id}>
                <ModelRow
                  roomId={roomId}
                  model={model}
                  isSteward={isSteward}
                  voteOpen={openVote !== null}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** The open member ratification vote: every member casts one yes/no ballot. */
function RatificationVotePanel({
  roomId,
  vote,
}: {
  roomId: string;
  vote: OpenVote;
}): React.ReactElement {
  const cast = useCastBallotMutation(roomId);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function vote_(choice: 'approve' | 'reject'): void {
    setError(null);
    cast.mutate(
      { voteId: vote.vote_id, choice },
      {
        onSuccess: () => setDone(true),
        onError: (e) =>
          setError(e instanceof ApiClientError ? e.message : 'Could not record your ballot.'),
      },
    );
  }

  return (
    <div className="neu-inset mt-3 flex flex-col gap-2 rounded-lg p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="info">Ratification vote open</Badge>
        <span className="text-ink-muted text-xs">
          In favour: {vote.in_favor} · Opposed: {vote.opposed} · Quorum: {vote.min_quorum}
        </span>
      </div>
      <p className="text-ink-muted text-sm">
        Members are voting on whether to adopt this model. It activates only if the vote reaches
        quorum with an approving majority by {new Date(vote.closes_at).toLocaleString()}.
      </p>
      {done ? (
        <p className="text-sm text-ink">Your ballot is recorded. Thank you.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={cast.isPending} onClick={() => vote_('approve')}>
            Approve
          </Button>
          <Button variant="secondary" disabled={cast.isPending} onClick={() => vote_('reject')}>
            Reject
          </Button>
        </div>
      )}
      {error ? <p className="text-error-on-soft text-xs">{error}</p> : null}
    </div>
  );
}

/** One row of the proposal registry: status, digest, download, and (for the
 *  steward, on an eligible model with no vote already open) "Open ratification". */
function ModelRow({
  roomId,
  model,
  isSteward,
  voteOpen,
}: {
  roomId: string;
  model: GovernanceModelSummary;
  isSteward: boolean;
  voteOpen: boolean;
}): React.ReactElement {
  const openVote = useOpenRatificationMutation(roomId);
  const [error, setError] = useState<string | null>(null);
  const meta = STATUS_META[model.status];

  function startVote(): void {
    setError(null);
    openVote.mutate(model.model_id, {
      onError: (e) =>
        setError(e instanceof ApiClientError ? e.message : 'Could not open the ratification vote.'),
    });
  }

  async function download(): Promise<void> {
    setError(null);
    try {
      downloadModelBundle(await downloadGovernanceModel(roomId, model.model_id));
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Could not download the model.');
    }
  }

  return (
    <div className="neu-inset flex flex-col gap-2 rounded-lg p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <span className="font-mono text-ink-muted text-xs">
          {model.artifact_digest.slice(0, 12)}
        </span>
        {/* Any member can pull + verify the content-addressed bundle (ADR-1). */}
        <Button variant="ghost" onClick={() => void download()}>
          Download
        </Button>
      </div>

      {/* The steward puts an eligible model to a member vote (one open at a time). */}
      {isSteward && model.status === 'eligible' && !voteOpen ? (
        <div>
          <Button variant="secondary" disabled={openVote.isPending} onClick={startVote}>
            Open ratification vote
          </Button>
        </div>
      ) : null}

      {error ? <p className="text-error-on-soft text-xs">{error}</p> : null}
    </div>
  );
}

/** The steward's propose form: a policy-bundle editor + a prompt, parsed client-side. */
function ProposeForm({ roomId }: { roomId: string }): React.ReactElement {
  const propose = useProposeModelMutation(roomId);
  const [open, setOpen] = useState(false);
  const [bundleText, setBundleText] = useState(STARTER_BUNDLE);
  const [promptText, setPromptText] = useState(STARTER_PROMPT);
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    setError(null);
    let bundle: unknown;
    try {
      bundle = JSON.parse(bundleText);
    } catch {
      setError('The model must be valid JSON.');
      return;
    }
    if (promptText.trim().length === 0) {
      setError('A prompt is required.');
      return;
    }
    propose.mutate(
      { bundle, prompt_text: promptText },
      {
        onSuccess: () => {
          setOpen(false);
          setError(null);
        },
        onError: (e) =>
          setError(
            e instanceof ApiClientError
              ? e.message
              : 'Could not propose the model. Check the policy bundle and try again.',
          ),
      },
    );
  }

  if (!open) {
    return (
      <div className="mt-3">
        <Button variant="primary" onClick={() => setOpen(true)}>
          Propose a model
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="mt-3 flex flex-col gap-3">
      <TextArea
        label="Policy bundle (JSON)"
        value={bundleText}
        onChange={(e) => setBundleText(e.target.value)}
        rows={12}
        textareaClassName="font-mono text-xs"
        helperText="A declarative, downloadable rule-set — no code runs. Members verify the digest."
      />
      <TextArea
        label="Agent prompt"
        value={promptText}
        onChange={(e) => setPromptText(e.target.value)}
        rows={3}
        maxLength={8_000}
        helperText="Guides the agent's tone on its advisory surfaces. It never grants powers."
      />
      {error ? <p className="text-error-on-soft text-sm">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={propose.isPending}>
          Submit proposal
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
