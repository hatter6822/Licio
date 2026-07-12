// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T debate arena — the live, open adjudication surface (SPEC §15.4/§24.6).
// A sourced correction opens a debate: the arena shows the REAL material under
// dispute — the challenged story/comment and the correction — live while the
// arena is open (either author may keep adjusting their content and an
// optional rebuttal statement; each sees the other's current case as it
// changes).  The debate queues for AI resolution by the EARLIER of: both
// sides idle for an hour (the expedited path), or the 23h edit deadline + a
// 1h locked countdown (the schedule).  While open, the challenger may
// withdraw the correction and the incumbent may concede.  The room's governed
// AI then renders a probabilistic verdict over the LOCKED material; the room
// STEWARD may fully overrule it for 24 hours.  A `corrected` outcome tags the
// loser "incorrect".
//
// Strictly no-applause: there is no member vote/tally anywhere — the outcome is a
// content-structural adjudication, not a popularity count.
import type { DebateArenaPublic, DebateContent, DebatePosition, DebateWinner } from '@licio/shared';
import {
  citationUrlSchema,
  DEBATE_INACTIVITY_WINDOW_MS,
  DEBATE_POSITION_BODY_LIMIT,
} from '@licio/shared';
import { lazy, Suspense, useState } from 'react';
import { cn } from '../../lib/cn.js';
import { useDebateStream } from '../../lib/debate-stream.js';
import {
  useCloseDebateMutation,
  useDebateQuery,
  useOverrideDebateMutation,
  usePostDebatePositionMutation,
} from '../../lib/queries.js';
import { raisedSurface } from '../../lib/surfaces.js';
import { MarkdownEditor } from '../composer/MarkdownEditor/index.js';
import { SafeExternalLink } from '../ugc/SafeExternalLink.js';
import { UgcBody } from '../ugc/UgcBody.js';
import { Button } from '../ui/Button/index.js';
import { ErrorState } from '../ui/ErrorState/index.js';
import { Icon } from '../ui/Icon/index.js';

const badge = 'rounded border px-1.5 py-px text-xs font-medium uppercase tracking-wide';

function remaining(deadline: string): { closed: boolean; label: string } {
  const ms = Date.parse(deadline) - Date.now();
  if (ms <= 0) return { closed: true, label: '' };
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return { closed: false, label: hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m` };
}

function Countdown({ deadline, label }: { deadline: string; label: string }): React.ReactElement {
  const r = remaining(deadline);
  return (
    <p className="text-sm text-ink-muted">
      {r.closed ? `${label} closed` : `${label}: ${r.label} remaining`}
    </p>
  );
}

/** A compact source list (shared by the content and rebuttal cards). */
function SourceList({
  heading,
  citations,
}: {
  heading: string;
  citations: readonly { url: string; title?: string | undefined }[];
}): React.ReactElement | null {
  if (citations.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" aria-label={`${heading} sources`}>
      {citations.map((c) => (
        <li key={c.url} className="flex items-start gap-1.5 text-sm">
          <Icon name="quote" className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden />
          <SafeExternalLink
            href={c.url}
            className="break-all font-medium text-primary-on-soft underline hover:no-underline"
          >
            {c.title ?? c.url}
          </SafeExternalLink>
        </li>
      ))}
    </ul>
  );
}

/** One side's REAL material under debate: the challenged story/comment (the
 *  incumbent's) or the correction (the challenger's).  Live while the arena
 *  is open — it re-renders as the author edits — and the locked snapshot from
 *  the lock onward (what the AI resolution queue judges). */
function ContentCard({
  heading,
  author,
  content,
}: {
  heading: string;
  author: string;
  content: DebateContent | null;
}): React.ReactElement {
  return (
    <section
      className={cn('flex flex-col gap-2 p-3', raisedSurface)}
      aria-label={`${heading} content`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-ink">
          {heading} <span className="font-normal text-ink-muted">· {author}</span>
        </h3>
        {content !== null ? (
          <span
            className={cn(
              badge,
              content.locked
                ? 'border-line text-ink-muted'
                : 'border-primary/40 text-primary-on-soft',
            )}
          >
            {content.locked ? 'Locked in' : 'Live'}
          </span>
        ) : null}
      </header>
      {content === null ? (
        <p className="text-sm text-ink-muted italic">This content is no longer available.</p>
      ) : content.removed ? (
        <p className="text-sm text-ink-muted italic">
          This content was removed and is no longer shown.
        </p>
      ) : (
        <>
          {content.title !== null && content.title.length > 0 ? (
            <p className="font-medium text-ink">{content.title}</p>
          ) : null}
          {content.body.length > 0 ? (
            <UgcBody markdown={content.body} compact />
          ) : content.title === null ? (
            <p className="text-sm text-ink-muted italic">No content.</p>
          ) : null}
          <SourceList heading={heading} citations={content.citations} />
        </>
      )}
    </section>
  );
}

/** One side's optional rebuttal statement, layered over their underlying
 *  content: read-only for observers; editable for its author while the arena
 *  is open. */
function PositionCard({
  debateId,
  position,
  editable,
  windowOpen,
}: {
  debateId: string;
  position: DebatePosition;
  editable: boolean;
  windowOpen: boolean;
}): React.ReactElement {
  const mutation = usePostDebatePositionMutation(debateId);
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(position.summary);
  const [sources, setSources] = useState<string[]>(position.citations.map((c) => c.url));
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const heading = position.side === 'incumbent' ? 'Incumbent rebuttal' : 'Challenger argument';
  const author = position.author_display_name ?? position.author_handle ?? 'Unknown';

  const addSource = (): void => {
    const url = draft.trim();
    if (!url) return;
    if (!citationUrlSchema.safeParse(url).success) {
      setError('Enter a valid http(s) or doi: link.');
      return;
    }
    if (!sources.includes(url)) setSources((prev) => [...prev, url]);
    setDraft('');
    setError(null);
  };

  const save = (): void => {
    if (summary.trim().length === 0) {
      setError('A position summary is required.');
      return;
    }
    if (sources.length === 0) {
      setError('A debate position needs at least one source.');
      return;
    }
    mutation.mutate(
      { summary: summary.trim(), citations: sources.map((url) => ({ url })) },
      { onSuccess: () => setEditing(false) },
    );
  };

  return (
    <section
      className={cn('flex flex-col gap-2 p-3', raisedSurface)}
      aria-label={`${heading} position`}
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold text-ink">
          {heading} <span className="font-normal text-ink-muted">· {author}</span>
        </h3>
        {editable && windowOpen && !editing ? (
          <Button type="button" variant="ghost" onClick={() => setEditing(true)}>
            {position.submitted ? 'Edit' : 'Post your case'}
          </Button>
        ) : null}
      </header>

      {editing ? (
        <div className="flex flex-col gap-2">
          <MarkdownEditor
            id={`debate-${position.side}`}
            label={`Your ${heading.toLowerCase()} case`}
            value={summary}
            onChange={setSummary}
            compact
            maxLength={DEBATE_POSITION_BODY_LIMIT}
            placeholder="Make your strongest, best-sourced case…"
          />
          {sources.length > 0 ? (
            <ul className="flex flex-col gap-1" aria-label="Your sources">
              {sources.map((url) => (
                <li key={url} className="flex items-center gap-1.5 text-sm">
                  <Icon name="quote" className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
                  <span className="min-w-0 flex-1 break-all text-ink-muted">{url}</span>
                  <button
                    type="button"
                    className="shrink-0 rounded px-1 text-sm text-ink-muted hover:text-error"
                    onClick={() => setSources((prev) => prev.filter((s) => s !== url))}
                    aria-label={`Remove ${url}`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-end gap-2">
            <input
              type="url"
              inputMode="url"
              value={draft}
              onChange={(e) => {
                setDraft(e.currentTarget.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addSource();
                }
              }}
              placeholder="Add a source"
              aria-label="Add a source"
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            />
            <Button
              type="button"
              variant="ghost"
              onClick={addSource}
              disabled={draft.trim().length === 0}
            >
              Add
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="button" variant="primary" loading={mutation.isPending} onClick={save}>
              Save position
            </Button>
          </div>
        </div>
      ) : position.submitted ? (
        <>
          <UgcBody markdown={position.summary} compact />
          <SourceList heading={heading} citations={position.citations} />
        </>
      ) : (
        <p className="text-sm text-ink-muted italic">No statement posted yet.</p>
      )}
    </section>
  );
}

/** The AI verdict banner + the steward's full-overrule control (24h window). */
function VerdictPanel({ arena }: { arena: DebateArenaPublic }): React.ReactElement | null {
  const mutation = useOverrideDebateMutation(arena.debate_id);
  const [reason, setReason] = useState('');
  const [choice, setChoice] = useState<DebateWinner>(arena.winner ?? 'none');
  if (arena.verdict === null) return null;

  const tone =
    arena.verdict === 'corrected'
      ? 'border-error/60 text-error'
      : arena.verdict === 'upheld'
        ? 'border-primary/40 text-primary-on-soft'
        : 'border-line text-ink-muted';
  const label =
    arena.verdict === 'corrected'
      ? 'Corrected — the challenger prevailed'
      : arena.verdict === 'upheld'
        ? 'Upheld — the incumbent stands'
        : 'Inconclusive';
  const overrideOpen =
    arena.viewer_role === 'steward' &&
    arena.state === 'judged' &&
    arena.override_deadline_at !== null &&
    Date.parse(arena.override_deadline_at) > Date.now();

  return (
    <div className={cn('flex flex-col gap-2 p-3', raisedSurface)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(badge, tone)}>{label}</span>
        <span className="text-sm text-ink-muted">
          Decided by{' '}
          {arena.decided_by === 'steward'
            ? 'the room steward'
            : arena.decided_by === 'concession'
              ? "the incumbent's concession"
              : "the room's AI"}
          {arena.confidence !== null ? ` · ${Math.round(arena.confidence * 100)}% confidence` : ''}
        </span>
      </div>
      {arena.rationale ? <p className="text-sm text-ink">{arena.rationale}</p> : null}
      {arena.overridden_by_handle ? (
        <p className="text-sm text-ink-muted">
          Overruled by steward {arena.overridden_by_handle}
          {arena.override_reason ? `: ${arena.override_reason}` : ''}
        </p>
      ) : null}

      {overrideOpen ? (
        <form
          className="mt-1 flex flex-col gap-2 border-t border-line pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim().length === 0) return;
            mutation.mutate({ winner: choice, reason: reason.trim() });
          }}
          aria-label="Steward override"
        >
          <p className="text-sm font-medium text-ink">Overrule the verdict (steward)</p>
          <div className="flex flex-wrap gap-2">
            {(['incumbent', 'challenger', 'none'] as const).map((w) => (
              <label key={w} className="flex items-center gap-1 text-sm text-ink">
                <input
                  type="radio"
                  name="override-winner"
                  checked={choice === w}
                  onChange={() => setChoice(w)}
                />
                {w === 'none' ? 'Inconclusive' : w === 'incumbent' ? 'Uphold' : 'Correct'}
              </label>
            ))}
          </div>
          <textarea
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.currentTarget.value)}
            placeholder="Reason for overruling (required)…"
            aria-label="Reason for overruling"
            className="min-h-16 rounded-md border border-line bg-surface p-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              loading={mutation.isPending}
              disabled={reason.trim().length === 0}
            >
              Overrule verdict
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/** The withdraw (challenger) / concede (incumbent) affordance — a two-step
 *  inline confirm, allowed only while the arena is open. */
function PartyExitControl({
  arena,
  debateId,
}: {
  arena: DebateArenaPublic;
  debateId: string;
}): React.ReactElement | null {
  const role = arena.viewer_role;
  const isChallenger = role === 'challenger';
  const mutation = useCloseDebateMutation(debateId, isChallenger ? 'withdraw' : 'concede');
  const [confirming, setConfirming] = useState(false);
  if (arena.state !== 'open' || (role !== 'challenger' && role !== 'incumbent')) return null;
  return (
    <div
      role="group"
      className="flex flex-wrap items-center gap-2"
      aria-label={isChallenger ? 'Withdraw the correction' : 'Concede the challenge'}
    >
      {confirming ? (
        <>
          <span className="text-sm text-ink">
            {isChallenger
              ? 'Withdraw the correction? The debate closes with no verdict.'
              : 'Concede? The correction prevails and your content is tagged Incorrect.'}
          </span>
          <Button
            type="button"
            variant="primary"
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {isChallenger ? 'Withdraw' : 'Concede'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
            Keep debating
          </Button>
        </>
      ) : (
        <Button type="button" variant="ghost" onClick={() => setConfirming(true)}>
          {isChallenger ? 'Withdraw the correction…' : 'Concede the challenge…'}
        </Button>
      )}
      {mutation.isError ? (
        <p role="alert" className="text-sm text-error">
          This debate can no longer be changed — the material may already be locked in.
        </p>
      ) : null}
    </div>
  );
}

/** DEV-ONLY: the debate fast-forward control (see DevFastForward.tsx) loads
 *  behind a compile-time gate — the conditional folds to `null` in a
 *  production build, so neither the component nor the simulator client ever
 *  enters a production chunk. */
const LazyDevFastForward = import.meta.env.DEV ? lazy(() => import('./DevFastForward.js')) : null;

export function DebateArena({
  debateId,
  storyId,
}: {
  debateId: string;
  storyId: string;
}): React.ReactElement {
  const query = useDebateQuery(debateId);
  const state = query.data?.debate.state;
  // Live co-visibility: stream while the arena is still active (a terminal
  // arena is static).  Each frame re-fetches the viewer's role-scoped view, so
  // each side sees the other's current material as it changes (backs the poll).
  useDebateStream(debateId, state !== 'resolved' && state !== 'withdrawn');

  if (query.isLoading) return <p className="text-sm text-ink-muted">Loading the debate…</p>;
  if (query.isError || !query.data) {
    return <ErrorState title="Debate unavailable" description="This debate could not be loaded." />;
  }
  const arena = query.data.debate;
  const windowOpen = arena.state === 'open' && Date.parse(arena.edit_deadline_at) > Date.now();
  const stateLabel: Record<DebateArenaPublic['state'], string> = {
    open: 'Live — both sides are making their case',
    locked: 'Locked in — the final countdown to AI resolution',
    awaiting_verdict: "In the room's AI resolution queue",
    judged: 'Judged — steward may overrule',
    resolved: 'Resolved',
    withdrawn: 'Withdrawn by the challenger — no verdict',
  };
  // The expedited path: the debate queues one inactivity window after the
  // LAST edit from either side (whichever comes before the 23h schedule).
  const lastActiveMs = Math.max(
    Date.parse(arena.incumbent_last_active_at),
    Date.parse(arena.challenger_last_active_at),
  );
  const idleQueueAt = new Date(lastActiveMs + DEBATE_INACTIVITY_WINDOW_MS).toISOString();
  const idleBeforeSchedule = windowOpen && idleQueueAt < arena.edit_deadline_at;

  const incumbentAuthor =
    arena.incumbent.author_display_name ?? arena.incumbent.author_handle ?? 'Unknown';
  const challengerAuthor =
    arena.challenger.author_display_name ?? arena.challenger.author_handle ?? 'Unknown';

  return (
    <section className="flex flex-col gap-4" aria-labelledby="debate-heading">
      <header className="flex flex-col gap-1">
        <h1 id="debate-heading" className="text-2xl font-semibold text-ink">
          Debate arena
        </h1>
        <p className="text-sm text-ink-muted">
          A sourced correction of a {arena.target_type}. The room's AI weighs both sides' content
          and sources — this is not a vote. {stateLabel[arena.state]}.
        </p>
        {windowOpen ? (
          <>
            <Countdown deadline={arena.edit_deadline_at} label="Editing window" />
            {idleBeforeSchedule ? (
              <p className="text-sm text-ink-muted">
                Resolves early once both sides stay idle for an hour
                {remaining(idleQueueAt).closed
                  ? ' (queueing imminently)'
                  : ` (~${remaining(idleQueueAt).label} unless someone edits)`}
                .
              </p>
            ) : null}
          </>
        ) : null}
        {arena.state === 'locked' ? (
          <Countdown deadline={arena.resolve_due_at} label="AI resolution" />
        ) : null}
        {arena.state === 'judged' && arena.override_deadline_at ? (
          <Countdown deadline={arena.override_deadline_at} label="Steward-override window" />
        ) : null}
      </header>

      <VerdictPanel arena={arena} />

      <div className="grid gap-3 md:grid-cols-2">
        <ContentCard
          heading={
            arena.target_type === 'story' ? 'The challenged story' : 'The challenged comment'
          }
          author={incumbentAuthor}
          content={arena.target_content}
        />
        <ContentCard
          heading="The correction"
          author={challengerAuthor}
          content={arena.correction_content}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <PositionCard
          debateId={debateId}
          position={arena.incumbent}
          editable={arena.viewer_role === 'incumbent'}
          windowOpen={windowOpen}
        />
        <PositionCard
          debateId={debateId}
          position={arena.challenger}
          editable={arena.viewer_role === 'challenger'}
          windowOpen={windowOpen}
        />
      </div>

      <PartyExitControl arena={arena} debateId={debateId} />
      {LazyDevFastForward !== null ? (
        <Suspense fallback={null}>
          <LazyDevFastForward debateId={debateId} />
        </Suspense>
      ) : null}

      <a
        href={`/stories/${encodeURIComponent(storyId)}`}
        className="text-sm text-primary-on-soft underline"
      >
        ← Back to the story
      </a>
    </section>
  );
}
