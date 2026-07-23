// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T live-debates modal — the story's debate INDEX, deep-linked via `?debates`
// and opened from the compact `LiveDebatesButton`.  Every arena on the story is
// one short summary row (state, countdown, subject, the two parties); activating
// a row opens the FULL arena for it (`?debate=<id>`), which replaces this list
// rather than stacking on it, so closing the arena lands back here.
//
// Three things earn their space here that a story-page panel could never hold:
//
//   1. THE STORY-CHALLENGE PIN.  Corrections aimed at the story itself lead the
//      list in their own group, above the comment challenges, under every sort
//      order and every search — `sortDebates` pins them in the comparator and
//      the leading group renders that pin visibly.
//   2. SEARCH over what each row shows (subject, parties, state, verdict) — a
//      hot story can carry dozens of arenas.
//   3. SORT: soonest deadline (the default — the debates a reader can still
//      influence), most recently active, newest, oldest.
//
// Strictly no-applause: rows are ordered by TIME and SUBJECT only. There is no
// vote, tally, or popularity ordering anywhere — the outcome of each debate is
// the room AI's content-structural adjudication.
import type { DebateArenaSummary, DebateState, DebateVerdict } from '@licio/shared';
import { useState } from 'react';
import { useNow } from '../../hooks/useNow.js';
import { useT } from '../../i18n/index.js';
import { cn } from '../../lib/cn.js';
import { useStoryDebatesQuery } from '../../lib/queries.js';
import { raisedInteractiveSm, raisedSurfaceSm } from '../../lib/surfaces.js';
import { highlightMatches, queryTokens } from '../search/highlight.js';
import { Badge, type BadgeTone } from '../ui/Badge/index.js';
import { EmptyState } from '../ui/EmptyState/index.js';
import { ErrorState } from '../ui/ErrorState/index.js';
import { Icon } from '../ui/Icon/index.js';
import { Input } from '../ui/Input/index.js';
import { LoadingState } from '../ui/LoadingState/index.js';
import { Select } from '../ui/Select/index.js';
import { Sheet } from '../ui/Sheet/index.js';
import {
  DEBATE_SORT_MODES,
  DEFAULT_DEBATE_SORT,
  type DebateRowLabels,
  type DebateSortMode,
  debateDeadline,
  debateMatchesTokens,
  debateSearchText,
  remainingLabel,
  sortDebates,
} from './debate-summary.js';
import { useOpenDebate } from './open-debate.js';

/** Short lifecycle labels — the row is a summary, so the badge names the state
 *  in one or two words and the arena carries the full sentence. */
function useStateLabels(): Record<DebateState, string> {
  const t = useT();
  return {
    open: t('debate.list.state.open', 'Live'),
    locked: t('debate.list.state.locked', 'Locked in'),
    awaiting_verdict: t('debate.list.state.awaiting', 'In the AI queue'),
    judged: t('debate.list.state.judged', 'Judged'),
    resolved: t('debate.list.state.resolved', 'Resolved'),
    withdrawn: t('debate.list.state.withdrawn', 'Withdrawn'),
  };
}

/** Verdict labels + tones, mirroring the arena's verdict banner. */
function useVerdictLabels(): Record<DebateVerdict, { label: string; tone: BadgeTone }> {
  const t = useT();
  return {
    corrected: {
      label: t('debate.list.verdict.corrected', 'Corrected'),
      tone: 'error',
    },
    upheld: { label: t('debate.list.verdict.upheld', 'Upheld'), tone: 'info' },
    inconclusive: {
      label: t('debate.list.verdict.inconclusive', 'Inconclusive'),
      tone: 'neutral',
    },
  };
}

/** The row's labels: the searchable set plus the verdict badge's tone (a
 *  display detail the search model has no business knowing about). */
interface RowLabels extends DebateRowLabels {
  verdictTone?: BadgeTone;
}

/** One debate, as a three-line summary row that opens its full arena. */
function DebateSummaryRow({
  debate,
  labels,
  tokens,
  onOpen,
}: {
  debate: DebateArenaSummary;
  labels: RowLabels;
  /** Query tokens to mark in the subject excerpt. */
  tokens: readonly string[];
  onOpen: (debateId: string) => void;
}): React.ReactElement {
  const t = useT();
  const now = useNow();
  const deadline = debateDeadline(debate);
  const time = deadline === null ? null : remainingLabel(deadline.at, now);
  const countdown =
    time === null || deadline === null
      ? null
      : deadline.kind === 'edit'
        ? t('debate.list.editingCloses', 'Editing closes in {time}', { time })
        : deadline.kind === 'resolve'
          ? t('debate.list.resolvesIn', 'AI resolution in {time}', { time })
          : t('debate.list.overrideCloses', 'Override window: {time}', { time });
  const unknown = t('debate.unknownAuthor', 'Unknown');

  return (
    <li>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => onOpen(debate.debate_id)}
        className={cn(
          'flex w-full items-center gap-3 p-3 text-start',
          raisedSurfaceSm,
          raisedInteractiveSm,
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={debate.state === 'open' ? 'info' : 'neutral'}>{labels.state}</Badge>
            {labels.verdict !== undefined ? (
              <Badge tone={labels.verdictTone ?? 'neutral'}>{labels.verdict}</Badge>
            ) : null}
            {countdown !== null ? (
              <span className="text-xs font-medium text-warning-on-soft">{countdown}</span>
            ) : null}
          </span>
          {/* The subject: the challenged comment's text, or — for a story-root
              challenge — the story's own title. Suppressed by the server when
              the target is held for review, so say so rather than showing a
              blank row. */}
          {debate.target_excerpt !== null ? (
            <span className="line-clamp-2 text-sm text-ink">
              “{highlightMatches(debate.target_excerpt, tokens)}”
            </span>
          ) : (
            <span className="text-sm text-ink-muted italic">
              {t('debate.list.noExcerpt', 'The challenged content is not currently shown.')}
            </span>
          )}
          <span className="truncate text-xs text-ink-muted">
            {t('debate.list.parties', '{incumbent} defends · {challenger} challenges', {
              incumbent: debate.incumbent_display_name ?? unknown,
              challenger: debate.challenger_display_name ?? unknown,
            })}
          </span>
        </span>
        <Icon name="chevron-right" className="size-4 shrink-0 text-ink-muted" aria-hidden />
      </button>
    </li>
  );
}

/** A titled group of rows (the story-challenge pin, then the comment ones). */
function DebateGroup({
  title,
  icon,
  rows,
}: {
  title: string;
  icon: 'layers' | 'quote';
  rows: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-ink-muted uppercase">
        <Icon name={icon} className="size-3.5" aria-hidden />
        {title}
      </h3>
      {/* gap-3 is the layout floor for a stack of `neu-raised-sm` tiles (8px
          reach) — see lib/surfaces.ts. */}
      <ul className="flex flex-col gap-3">{rows}</ul>
    </section>
  );
}

/**
 * The modal body (exported for tests; the Sheet host is below).  Reads the same
 * `useStoryDebatesQuery` cache entry the trigger renders from, so opening the
 * list costs no extra request — and inherits its poll, so a debate that opens
 * while the list is up appears in it.
 */
export function LiveDebatesList({ storyId }: { storyId: string }): React.ReactElement {
  const t = useT();
  const query = useStoryDebatesQuery(storyId);
  const openDebate = useOpenDebate();
  const stateLabels = useStateLabels();
  const verdictLabels = useVerdictLabels();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<DebateSortMode>(DEFAULT_DEBATE_SORT);

  const sortLabels: Record<DebateSortMode, string> = {
    urgent: t('debate.list.sort.urgent', 'Ending soonest'),
    recent: t('debate.list.sort.recent', 'Recently active'),
    newest: t('debate.list.sort.newest', 'Newest first'),
    oldest: t('debate.list.sort.oldest', 'Oldest first'),
  };
  const targetLabels = {
    story: t('debate.list.group.story', 'Challenges to this story'),
    comment: t('debate.list.group.comment', 'Challenges to comments'),
  };

  if (query.isLoading) {
    return <LoadingState rows={2} label={t('debate.list.loading', 'Loading live debates…')} />;
  }
  if (query.isError) {
    return (
      <ErrorState
        headingLevel={3}
        title={t('debate.list.error.title', 'Live debates unavailable')}
        description={t(
          'debate.list.error.description',
          'The debates on this story could not be loaded.',
        )}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const all = query.data?.debates ?? [];
  if (all.length === 0) {
    return (
      <EmptyState
        headingLevel={3}
        icon="threads"
        title={t('debate.list.empty.title', 'No live debates')}
        description={t(
          'debate.list.empty.description',
          'Nothing on this story is under a sourced correction right now. Raise one with “Correct”.',
        )}
      />
    );
  }

  // Row labels are built ONCE per debate and used for both the display and the
  // search haystack, so a reader can only ever fail to find what they can see.
  const tokens = queryTokens(search.trim());
  const rows = sortDebates(all, sort)
    .map((debate) => {
      const verdict = debate.verdict === null ? undefined : verdictLabels[debate.verdict];
      const labels: RowLabels = {
        target: debate.target_type === 'story' ? targetLabels.story : targetLabels.comment,
        state: stateLabels[debate.state],
        ...(verdict ? { verdict: verdict.label, verdictTone: verdict.tone } : {}),
      };
      return { debate, labels };
    })
    .filter((row) => debateMatchesTokens(debateSearchText(row.debate, row.labels), tokens));

  const storyRows = rows.filter((row) => row.debate.target_type === 'story');
  const commentRows = rows.filter((row) => row.debate.target_type !== 'story');
  const renderRow = (row: (typeof rows)[number]): React.ReactElement => (
    <DebateSummaryRow
      key={row.debate.debate_id}
      debate={row.debate}
      labels={row.labels}
      tokens={tokens}
      onOpen={openDebate}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Search + sort share ONE row: on a phone the controls cost a single
          line, leaving the sheet's height to the debates themselves.  The row
          STICKS to the top of the scrolling sheet (bleeding to its edges over
          the content passing under it), so refining a long list never means
          scrolling back up for the controls. */}
      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-end gap-2 border-b border-line bg-canvas px-4 pt-1 pb-2">
        <Input
          type="search"
          label={t('debate.list.searchLabel', 'Search live debates')}
          hideLabel
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder={t('debate.list.searchPlaceholder', 'Search debates…')}
          className="min-w-40 flex-1"
        />
        <Select
          label={t('debate.list.sortLabel', 'Sort live debates')}
          hideLabel
          value={sort}
          onValueChange={(value) => setSort(value as DebateSortMode)}
          options={DEBATE_SORT_MODES.map((mode) => ({ value: mode, label: sortLabels[mode] }))}
          className="w-44 shrink-0"
        />
      </div>

      {/* Announce the narrowing: a filtered count is the only feedback a
          screen-reader user gets that their query did anything. */}
      {tokens.length > 0 ? (
        <p role="status" className="text-sm text-ink-muted">
          {t('debate.list.matchCount', 'Showing {shown} of {total}', {
            shown: rows.length,
            total: all.length,
          })}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          headingLevel={3}
          icon="search"
          title={t('debate.list.noMatch.title', 'No debates match your search')}
          description={t(
            'debate.list.noMatch.description',
            'Try a shorter term, or clear the search to see every live debate.',
          )}
          action={{
            label: t('debate.list.clearSearch', 'Clear search'),
            onAction: () => setSearch(''),
          }}
        />
      ) : null}

      {/* The pin, made structural: challenges to the STORY lead the modal in
          their own group, whatever the sort or the search. */}
      {storyRows.length > 0 ? (
        <DebateGroup title={targetLabels.story} icon="layers" rows={storyRows.map(renderRow)} />
      ) : null}
      {commentRows.length > 0 ? (
        <DebateGroup title={targetLabels.comment} icon="quote" rows={commentRows.map(renderRow)} />
      ) : null}
    </div>
  );
}

/**
 * The live-debates modal host: open exactly while `?debates` is present AND no
 * `?debate=<id>` arena is (the host page owns that arbitration), so the two
 * never stack.  Closing clears the param, so back/refresh behave honestly.
 */
export function LiveDebatesModal({
  storyId,
  open,
  onClose,
}: {
  storyId: string;
  open: boolean;
  onClose: () => void;
}): React.ReactElement | null {
  const t = useT();
  if (!open) return null;
  return (
    <Sheet
      open
      onClose={onClose}
      title={t('debate.list.title', 'Live debates')}
      className="max-w-2xl"
    >
      <LiveDebatesList storyId={storyId} />
    </Sheet>
  );
}
