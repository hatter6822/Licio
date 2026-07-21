// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U governance write surface (SPEC §16.6, §24.6). Model candidacy is a
// MEMBER power: any governance-eligible room member proposes a community AI
// **model** (a declarative, member-downloadable GovernancePolicyBundle —
// optionally selecting hub models per governed role) and its **prompt**, and
// the MEMBERS adopt it by ratification vote. The elected steward VALIDATES
// rather than authors — their pipeline powers are checks: opening the
// ratification vote on an admitted proposal (which candidates face a vote) and
// CANCELLING an improper open vote (the last line of defence; the candidate
// stays eligible, a fresh vote may open). The model activates only if the vote
// passes (settled by the scheduler at the window close). The registry
// (proposal pipeline + admission status) is shown to every member for
// transparency. No applause primitives; the vote shows governance counts
// (in favour / opposed), never a popularity signal.

import type {
  GovernanceModelSummary,
  HubModelRef,
  ModelHubSearchResult,
  RatificationViewResponse,
} from '@licio/shared';
import { hubModelRefSchema } from '@licio/shared';
import { useState } from 'react';
import { useT } from '../../i18n/index.js';
import { ApiClientError } from '../../lib/api.js';
import { downloadGovernanceModel } from '../../lib/governance-api.js';
import { downloadModelBundle } from '../../lib/governance-download.js';
import { resolveModelHubModel, searchModelHub } from '../../lib/model-hub-api.js';
import {
  useCancelRatificationMutation,
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
 * A valid starter policy bundle that passes the platform admission gate. The
 * `moderationPrompt` conditions the in-room moderation MODEL (an LLM); the
 * platform's deterministic wrapper bounds whatever it proposes (an
 * escalate-to-human-review ceiling + the community-granted capability), so a
 * benign comment is never over-moderated and the model can never exceed the
 * community-voted powers. The proposing member edits this to express the
 * community's policy.
 */
const STARTER_BUNDLE = `{
  "bundleId": "starter-civility",
  "version": "1",
  "name": "Starter civility policy",
  "moderationPrompt": "Route link-heavy, spammy, or otherwise suspicious contributions to human review; allow civil, on-topic content.",
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
  /** Render inside the governance modal's tab: no card chrome or duplicate
   *  heading, and always render the shell (an honest empty registry rather than
   *  nothing) since the reader explicitly opened the governance surface. */
  embedded?: boolean;
  /** True when the reader has an ACTIVE subscription to this room. A member may
   *  cast a ratification ballot; a non-member is shown how to join instead —
   *  mirroring the backend gate (`isRoomMember`), so the buttons never 403. */
  joined?: boolean;
  /** True when the reader holds a steward ROLE in this room (`room.is_steward`).
   *  The backend `isRoomMember` gate counts a room steward as a member (active
   *  subscription OR steward role) even WITHOUT a subscription, so a room steward
   *  must be able to cast a ballot — not be told to join (RoomMembership renders
   *  no join affordance for them, since they are already members via the role). */
  isRoomSteward?: boolean;
}

export function StewardModelManager({
  roomId,
  enabled = true,
  joined = false,
  isRoomSteward = false,
  embedded = false,
}: StewardModelManagerProps): React.ReactElement | null {
  const t = useT();
  const seat = useStewardSeatQuery(roomId, enabled);
  const models = useGovernanceModelsQuery(roomId, enabled);
  const ratification = useRatificationQuery(roomId, enabled);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);

  const holder = seat.data?.seat?.holder_user_id ?? null;
  const isSteward = holder !== null && holder === currentUserId;
  // A member, per the backend `isRoomMember`: an active subscription OR a room
  // steward role (the elected seat holder, who is subscribed, is covered too).
  const isMember = joined || isRoomSteward || isSteward;
  const items = models.data?.models ?? [];
  const openVote = ratification.data?.vote ?? null;

  // Nothing to show until there's a proposal, an open vote, or a member viewer
  // (members hold the propose affordance) — UNLESS embedded in the governance
  // modal, where the reader explicitly opened the surface and an honest empty
  // registry is clearer than a blank tab.
  if (!embedded && !isMember && items.length === 0 && openVote === null) return null;

  const inner = (
    <>
      <p className="mt-1 text-sm text-ink-muted">
        {t(
          'room.governance.models.intro',
          "Any governance-eligible member proposes an AI model and prompt; the community adopts it by member vote, with the elected steward validating which admitted proposals face a vote. A model governs the room only within community-voted, kernel-enforced limits, and never below Licio's non-overridable platform floor.",
        )}
      </p>

      {isMember ? <ProposeForm roomId={roomId} /> : null}

      {openVote ? (
        <RatificationVotePanel
          roomId={roomId}
          vote={openVote}
          canVote={isMember}
          isSteward={isSteward}
        />
      ) : null}

      <div className="mt-4">
        <h3 className="text-sm font-medium">
          {t('room.governance.proposals.heading', 'Proposals')}
        </h3>
        {models.isLoading ? (
          <LoadingState label={t('room.governance.models.loading', 'Loading governance models')} />
        ) : models.isError ? (
          <ErrorState
            title={t('room.governance.models.error.title', "Couldn't load governance models")}
            description={t(
              'room.governance.models.error.desc',
              'The model registry is unavailable right now.',
            )}
          />
        ) : items.length === 0 ? (
          <p className="mt-1 text-sm text-ink-muted">
            {t('room.governance.models.none', 'No models have been proposed yet.')}
          </p>
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
    </>
  );

  if (embedded) {
    return <div className="flex flex-col">{inner}</div>;
  }

  return (
    <Card as="section">
      <h2 className="text-base font-semibold">
        {t('room.governance.models.heading', 'Community governance models')}
      </h2>
      {inner}
    </Card>
  );
}

/** The open member ratification vote: every member casts one yes/no ballot;
 *  the steward additionally holds the improper-vote CANCEL (no outcome). */
function RatificationVotePanel({
  roomId,
  vote,
  canVote,
  isSteward,
}: {
  roomId: string;
  vote: OpenVote;
  canVote: boolean;
  isSteward: boolean;
}): React.ReactElement {
  const t = useT();
  const cast = useCastBallotMutation(roomId);
  const cancel = useCancelRatificationMutation(roomId);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function vote_(choice: 'approve' | 'reject'): void {
    setError(null);
    cast.mutate(
      { voteId: vote.vote_id, choice },
      {
        onSuccess: () => setDone(true),
        onError: (e) =>
          setError(
            e instanceof ApiClientError
              ? e.message
              : t('room.governance.ballot.error', 'Could not record your ballot.'),
          ),
      },
    );
  }

  function cancelVote(): void {
    setError(null);
    cancel.mutate(vote.vote_id, {
      onError: (e) =>
        setError(
          e instanceof ApiClientError
            ? e.message
            : t('room.governance.cancel.error', 'Could not cancel the vote.'),
        ),
    });
  }

  return (
    <div className="neu-inset mt-3 flex flex-col gap-2 rounded-lg p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="info">{t('room.governance.vote.open', 'Ratification vote open')}</Badge>
        <span className="text-ink-muted text-xs">
          {t('room.governance.vote.inFavour', 'In favour')}: {vote.in_favor} ·{' '}
          {t('room.governance.vote.opposed', 'Opposed')}: {vote.opposed} ·{' '}
          {t('room.governance.vote.quorum', 'Quorum')}: {vote.min_quorum}
        </span>
      </div>
      <p className="text-ink-muted text-sm">
        {t(
          'room.governance.vote.explain',
          'Members are voting on whether to adopt this model. It activates only if the vote reaches quorum with an approving majority by',
        )}{' '}
        {new Date(vote.closes_at).toLocaleString()}.
      </p>
      {!canVote ? (
        <p className="text-ink-muted text-sm">
          {t('room.governance.vote.join', 'Join the room to take part in this vote.')}
        </p>
      ) : done ? (
        <p className="text-sm text-ink">
          {t('room.governance.vote.recorded', 'Your ballot is recorded. Thank you.')}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={cast.isPending} onClick={() => vote_('approve')}>
            {t('room.governance.vote.approve', 'Approve')}
          </Button>
          <Button variant="secondary" disabled={cast.isPending} onClick={() => vote_('reject')}>
            {t('room.governance.vote.reject', 'Reject')}
          </Button>
        </div>
      )}
      {isSteward ? (
        <div>
          {/* The steward's improper-vote defence: close the vote with NO
              outcome (the candidate stays eligible; a fresh vote may open). */}
          <Button variant="ghost" disabled={cancel.isPending} onClick={cancelVote}>
            {t('room.governance.vote.cancel', 'Cancel this vote (steward)')}
          </Button>
        </div>
      ) : null}
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
  const t = useT();
  const openVote = useOpenRatificationMutation(roomId);
  const [error, setError] = useState<string | null>(null);
  const meta = STATUS_META[model.status];

  function startVote(): void {
    setError(null);
    openVote.mutate(model.model_id, {
      onError: (e) =>
        setError(
          e instanceof ApiClientError
            ? e.message
            : t('room.governance.openVote.error', 'Could not open the ratification vote.'),
        ),
    });
  }

  async function download(): Promise<void> {
    setError(null);
    try {
      downloadModelBundle(await downloadGovernanceModel(roomId, model.model_id));
    } catch (e) {
      setError(
        e instanceof ApiClientError
          ? e.message
          : t('room.governance.download.error', 'Could not download the model.'),
      );
    }
  }

  return (
    <div className="neu-inset flex flex-col gap-2 rounded-lg p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={meta.tone}>{t(`room.governance.status.${model.status}`, meta.label)}</Badge>
        <span className="font-mono text-ink-muted text-xs">
          {model.artifact_digest.slice(0, 12)}
        </span>
        {/* Any member can pull + verify the content-addressed bundle. */}
        <Button variant="ghost" onClick={() => void download()}>
          {t('room.governance.model.download', 'Download')}
        </Button>
      </div>

      {/* The steward puts an eligible model to a member vote (one open at a time). */}
      {isSteward && model.status === 'eligible' && !voteOpen ? (
        <div>
          <Button variant="secondary" disabled={openVote.isPending} onClick={startVote}>
            {t('room.governance.model.openVote', 'Open ratification vote')}
          </Button>
        </div>
      ) : null}

      {error ? <p className="text-error-on-soft text-xs">{error}</p> : null}
    </div>
  );
}

/** The two governed model roles a bundle may select a hub model for. */
type HubRole = 'moderation' | 'adjudication';

/** Read the bundle JSON's current selection for a role (null on invalid JSON
 *  or no selection) — the TEXTAREA stays the single source of truth; the
 *  picker only reads and rewrites it. */
function selectionOf(bundleText: string, role: HubRole): HubModelRef | null {
  try {
    const parsed = JSON.parse(bundleText) as Record<string, unknown>;
    const selection = parsed['modelSelection'];
    if (typeof selection !== 'object' || selection === null) return null;
    const ref = (selection as Record<string, unknown>)[role];
    const validated = hubModelRefSchema.safeParse(ref);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

/** Merge (or clear) a role's hub selection into the bundle JSON. Returns null
 *  when the textarea is not valid JSON (the caller surfaces the error). */
function mergeSelection(bundleText: string, role: HubRole, ref: HubModelRef | null): string | null {
  try {
    const parsed = JSON.parse(bundleText) as Record<string, unknown>;
    const existing = parsed['modelSelection'];
    const selection: Record<string, unknown> = {
      ...(typeof existing === 'object' && existing !== null
        ? (existing as Record<string, unknown>)
        : {}),
    };
    if (ref === null) delete selection[role];
    else selection[role] = ref;
    if (Object.keys(selection).length === 0) delete parsed['modelSelection'];
    else parsed['modelSelection'] = selection;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

/**
 * The per-role hub model picker (WS-U model candidacy): search public
 * huggingface.co models through the BFF proxy, pin the selected repo at its
 * CURRENT head revision, and write the reference into the bundle JSON — the
 * exact weights members then ratify. Gated models are shown but not
 * selectable (the platform rejects them as candidates).
 */
function HubModelPicker({
  hubRole,
  bundleText,
  onBundleText,
}: {
  hubRole: HubRole;
  bundleText: string;
  /** FUNCTIONAL updates only: the pin resolves asynchronously, and merging
   *  against a render-time snapshot would silently revert anything the author
   *  typed (or the other picker merged) while the resolve was in flight. */
  onBundleText: (updater: (prev: string) => string) => void;
}): React.ReactElement {
  const t = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ModelHubSearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = selectionOf(bundleText, hubRole);
  const roleLabel =
    hubRole === 'moderation'
      ? t('room.governance.hub.roleModeration', 'Moderation model')
      : t('room.governance.hub.roleAdjudication', 'Adjudication model');

  async function search(): Promise<void> {
    if (query.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const response = await searchModelHub(query.trim());
      setResults(response.results);
    } catch (e) {
      setResults(null);
      setError(
        e instanceof ApiClientError
          ? e.message
          : t('room.governance.hub.searchError', 'Model search is unavailable right now.'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function pick(repoId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { metadata } = await resolveModelHubModel(repoId);
      // Merge against the LATEST text (never the render-time snapshot): the
      // author may have kept editing — or the other picker merged — while the
      // pin resolved, and a stale-snapshot write would silently revert them.
      let mergeFailed = false;
      onBundleText((prev) => {
        const merged = mergeSelection(prev, hubRole, {
          source: 'huggingface',
          repoId: metadata.repo_id,
          revision: metadata.revision,
        });
        if (merged === null) {
          mergeFailed = true;
          return prev;
        }
        return merged;
      });
      if (mergeFailed) {
        setError(t('room.governance.propose.invalidJson', 'The model must be valid JSON.'));
        return;
      }
      setResults(null);
    } catch (e) {
      setError(
        e instanceof ApiClientError
          ? e.message
          : t('room.governance.hub.pinError', 'Could not pin that model. Try again.'),
      );
    } finally {
      setBusy(false);
    }
  }

  function clear(): void {
    onBundleText((prev) => mergeSelection(prev, hubRole, null) ?? prev);
  }

  return (
    <fieldset className="rounded-md border border-line p-3">
      <legend className="px-1 text-sm font-medium">{roleLabel}</legend>
      {current ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-mono text-xs">{current.repoId}</span>
          <Badge tone="info">
            {t('room.governance.hub.pinned', 'pinned')} {current.revision.slice(0, 12)}
          </Badge>
          <Button type="button" variant="ghost" onClick={clear}>
            {t('room.governance.hub.useDefault', 'Use platform default')}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-ink-muted">
          {t(
            'room.governance.hub.defaultInUse',
            'The project-wide default model serves this role. Search huggingface.co to propose a different one.',
          )}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter searches — it must NEVER implicitly submit the surrounding
            // propose form (an accidental proposal instead of a search).
            if (e.key === 'Enter') {
              e.preventDefault();
              void search();
            }
          }}
          aria-label={t(
            'room.governance.hub.searchLabel',
            'Search huggingface.co models for {role}',
            {
              role: roleLabel,
            },
          )}
          placeholder={t('room.governance.hub.searchPlaceholder', 'e.g. Qwen3Guard')}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-sm"
        />
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void search()}>
          {t('room.governance.hub.search', 'Search')}
        </Button>
      </div>
      {results !== null ? (
        results.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">
            {t('room.governance.hub.noResults', 'No matching public text models.')}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {results.map((result) => (
              <li key={result.repo_id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-xs">{result.repo_id}</span>
                {result.license ? <Badge tone="neutral">{result.license}</Badge> : null}
                {result.gated ? (
                  <Badge tone="error">
                    {t('room.governance.hub.gated', 'gated — not selectable')}
                  </Badge>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void pick(result.repo_id)}
                  >
                    {t('room.governance.hub.select', 'Select')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )
      ) : null}
      {error ? <p className="mt-1 text-error-on-soft text-xs">{error}</p> : null}
    </fieldset>
  );
}

/** The steward's propose form: a policy-bundle editor + a prompt, parsed client-side. */
function ProposeForm({ roomId }: { roomId: string }): React.ReactElement {
  const t = useT();
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
      setError(t('room.governance.propose.invalidJson', 'The model must be valid JSON.'));
      return;
    }
    if (promptText.trim().length === 0) {
      setError(t('room.governance.propose.promptRequired', 'A prompt is required.'));
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
              : t(
                  'room.governance.propose.error',
                  'Could not propose the model. Check the policy bundle and try again.',
                ),
          ),
      },
    );
  }

  if (!open) {
    return (
      <div className="mt-3">
        <Button variant="primary" onClick={() => setOpen(true)}>
          {t('room.governance.propose.open', 'Propose a model')}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="mt-3 flex flex-col gap-3">
      <TextArea
        label={t('room.governance.propose.bundleLabel', 'Policy bundle (JSON)')}
        value={bundleText}
        onChange={(e) => setBundleText(e.target.value)}
        rows={12}
        textareaClassName="font-mono text-xs"
        helperText={t(
          'room.governance.propose.bundleHelp',
          'A declarative, downloadable model bundle — no code runs. The moderation prompt guides the in-room model; the platform bounds every action it can take. Members verify the digest.',
        )}
      />
      <HubModelPicker hubRole="moderation" bundleText={bundleText} onBundleText={setBundleText} />
      <HubModelPicker hubRole="adjudication" bundleText={bundleText} onBundleText={setBundleText} />
      <TextArea
        label={t('room.governance.propose.promptLabel', 'Agent prompt')}
        value={promptText}
        onChange={(e) => setPromptText(e.target.value)}
        rows={3}
        maxLength={8_000}
        helperText={t(
          'room.governance.propose.promptHelp',
          "Guides the agent's tone on its advisory surfaces. It never grants powers.",
        )}
      />
      {error ? <p className="text-error-on-soft text-sm">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={propose.isPending}>
          {t('room.governance.propose.submit', 'Submit proposal')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t('common.cancel', 'Cancel')}
        </Button>
      </div>
    </form>
  );
}
