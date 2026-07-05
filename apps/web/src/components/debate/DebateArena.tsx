// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T debate arena — the live, open adjudication surface (SPEC §15.4/§24.6).
// A sourced correction opens a debate: the INCUMBENT (the challenged content's
// author) and the CHALLENGER each post + edit a co-visible position (summary +
// sources) for 12 hours — each sees the other's current draft while the window
// is open (the query polls) so both offer their strongest case.  The room's
// governed AI then renders a probabilistic verdict; the room STEWARD may fully
// overrule it for 24 hours.  A `corrected` outcome tags the loser "incorrect".
//
// Strictly no-applause: there is no member vote/tally anywhere — the outcome is a
// content-structural adjudication, not a popularity count.
import type { DebateArenaPublic, DebatePosition, DebateWinner } from '@licio/shared';
import { citationUrlSchema, DEBATE_POSITION_BODY_LIMIT } from '@licio/shared';
import { useState } from 'react';
import { cn } from '../../lib/cn.js';
import { useDebateStream } from '../../lib/debate-stream.js';
import {
  useDebateQuery,
  useOverrideDebateMutation,
  usePostDebatePositionMutation,
} from '../../lib/queries.js';
import { raisedSurface } from '../../lib/surfaces.js';
import { MarkdownEditor } from '../composer/MarkdownEditor/index.js';
import { UgcBody } from '../ugc/UgcBody.js';
import { Button } from '../ui/Button/index.js';
import { ErrorState } from '../ui/ErrorState/index.js';
import { Icon } from '../ui/Icon/index.js';

const badge = 'rounded border px-1.5 py-px text-xs font-medium uppercase tracking-wide';

function Countdown({ deadline, label }: { deadline: string; label: string }): React.ReactElement {
  const ms = Date.parse(deadline) - Date.now();
  const closed = ms <= 0;
  const hours = Math.max(0, Math.floor(ms / 3_600_000));
  const minutes = Math.max(0, Math.floor((ms % 3_600_000) / 60_000));
  return (
    <p className="text-sm text-ink-muted">
      {closed ? `${label} closed` : `${label}: ${hours}h ${minutes}m remaining`}
    </p>
  );
}

/** One side's position: read-only for observers; editable for its author while
 *  the 12h window is open. */
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

  const heading = position.side === 'incumbent' ? 'Incumbent' : 'Challenger';
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
          {position.citations.length > 0 ? (
            <ul className="flex flex-col gap-1" aria-label={`${heading} sources`}>
              {position.citations.map((c) => (
                <li key={c.url} className="flex items-start gap-1.5 text-sm">
                  <Icon
                    name="quote"
                    className="mt-0.5 size-3.5 shrink-0 text-ink-muted"
                    aria-hidden
                  />
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer nofollow"
                    className="break-all font-medium text-primary-on-soft underline hover:no-underline"
                  >
                    {c.title ?? c.url}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-ink-muted italic">No position posted yet.</p>
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
          Decided by {arena.decided_by === 'steward' ? 'the room steward' : "the room's AI"}
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

export function DebateArena({
  debateId,
  storyId,
}: {
  debateId: string;
  storyId: string;
}): React.ReactElement {
  const query = useDebateQuery(debateId);
  // Live co-visibility: stream while the arena is still active (a resolved arena
  // is static).  Each frame re-fetches the viewer's role-scoped view, so each
  // side sees the other's current draft as they edit (backs up the poll).
  useDebateStream(debateId, query.data?.debate.state !== 'resolved');

  if (query.isLoading) return <p className="text-sm text-ink-muted">Loading the debate…</p>;
  if (query.isError || !query.data) {
    return <ErrorState title="Debate unavailable" description="This debate could not be loaded." />;
  }
  const arena = query.data.debate;
  const windowOpen = arena.state === 'open' && Date.parse(arena.edit_deadline_at) > Date.now();
  const stateLabel: Record<DebateArenaPublic['state'], string> = {
    open: 'Open — both sides are making their case',
    awaiting_verdict: 'Editing closed — awaiting the verdict',
    judged: 'Judged — steward may overrule',
    resolved: 'Resolved',
  };

  return (
    <section className="flex flex-col gap-4" aria-labelledby="debate-heading">
      <header className="flex flex-col gap-1">
        <h1 id="debate-heading" className="text-2xl font-semibold text-ink">
          Debate arena
        </h1>
        <p className="text-sm text-ink-muted">
          A sourced correction of a {arena.target_type}. The room's AI weighs both sides' sources —
          this is not a vote. {stateLabel[arena.state]}.
        </p>
        {windowOpen ? <Countdown deadline={arena.edit_deadline_at} label="Editing window" /> : null}
        {arena.state === 'judged' && arena.override_deadline_at ? (
          <Countdown deadline={arena.override_deadline_at} label="Steward-override window" />
        ) : null}
      </header>

      <VerdictPanel arena={arena} />

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

      <a
        href={`/stories/${encodeURIComponent(storyId)}`}
        className="text-sm text-primary-on-soft underline"
      >
        ← Back to the story
      </a>
    </section>
  );
}
