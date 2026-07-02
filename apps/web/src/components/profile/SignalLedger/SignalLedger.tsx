// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Signal Ledger (WS-B.2.6). A PRIVATE, read-only account of the attention
// signals the owner generated, shown only to that owner.
//
// CRITICAL (no-applause doctrine): the ledger NEVER renders a public score, a
// rank, or any raw numeric signal value. Each signal is surfaced solely as a
// human-readable phrasing of what the owner did — never "+1", "12 points",
// "rank 3", etc. The mapping below is the single source for those phrasings.
import { useId } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { relativeTimeShort } from '../../../lib/time.js';
import { Icon } from '../../ui/Icon/index.js';

/** The closed vocabulary of attention signals an item can carry. */
export type SignalKind =
  | 'active_dwell'
  | 'source_opened'
  | 'context_opened'
  | 'thread_traversal'
  | 'saved_for_later'
  | 'contribution_created'
  | 'return_visit';

/**
 * The §5.3 anti-signals a reader may see applied to their OWN ledger — surfaced
 * as qualitative wording (never a number, never a public sanction) so the
 * reader understands why something counted less. Mirrors the shared
 * `LEDGER_ANTI_SIGNALS` vocabulary.
 */
export type LedgerAntiSignalKind =
  | 'rapid_repetition'
  | 'coordinated_burst'
  | 'rage_loop'
  | 'source_free_accusation'
  | 'brigading'
  | 'harassment_cascade';

export interface SignalLedgerItem {
  id: string;
  title: string;
  signals: SignalKind[];
  /** When this activity was counted (ISO) — surfaces the hourly cadence. */
  recordedAt?: string;
  /** Anti-signals applied to this item, shown qualitatively (§5.3). */
  antiSignals?: LedgerAntiSignalKind[];
  /** The per-item attention cap was hit; counting stopped (no number shown). */
  capReached?: boolean;
  /**
   * Server-generated plain-language explanation of how the signals were
   * counted (WS-E.2.1d) — qualitative wording only, never a number or score.
   */
  summary?: string;
}

export interface SignalLedgerProps {
  items: SignalLedgerItem[];
  /** Heading level for the panel title so it fits its surrounding hierarchy. */
  headingLevel?: 2 | 3;
  className?: string;
}

// Signal → human-readable phrasing. Strictly qualitative: there is deliberately
// no count, weight, or score in any of these strings.
const SIGNAL_COPY: Record<SignalKind, { key: string; text: string }> = {
  active_dwell: { key: 'signalLedger.signal.activeDwell', text: 'You spent active reading time' },
  source_opened: { key: 'signalLedger.signal.sourceOpened', text: 'You opened the source' },
  context_opened: { key: 'signalLedger.signal.contextOpened', text: 'You opened context' },
  thread_traversal: {
    key: 'signalLedger.signal.threadTraversal',
    text: 'You read across the discussion',
  },
  saved_for_later: {
    key: 'signalLedger.signal.savedForLater',
    text: 'You saved this for later',
  },
  contribution_created: {
    key: 'signalLedger.signal.contributionCreated',
    text: 'You contributed',
  },
  return_visit: { key: 'signalLedger.signal.returnVisit', text: 'You returned to follow up' },
};

// Anti-signal → qualitative wording. No number, no rank, never a public
// sanction — a private, plain-language note on why something counted less.
const ANTI_SIGNAL_COPY: Record<LedgerAntiSignalKind, { key: string; text: string }> = {
  rapid_repetition: {
    key: 'signalLedger.antiSignal.rapidRepetition',
    text: 'Rapid repeats were counted once',
  },
  coordinated_burst: {
    key: 'signalLedger.antiSignal.coordinatedBurst',
    text: 'Counted with a coordination review',
  },
  rage_loop: {
    key: 'signalLedger.antiSignal.rageLoop',
    text: 'Repeated hostile returns were not counted',
  },
  source_free_accusation: {
    key: 'signalLedger.antiSignal.sourceFreeAccusation',
    text: 'An accusation without a source counted less',
  },
  brigading: {
    key: 'signalLedger.antiSignal.brigading',
    text: 'Counted with a brigading review',
  },
  harassment_cascade: {
    key: 'signalLedger.antiSignal.harassmentCascade',
    text: 'Counted with a safety review',
  },
};

export function SignalLedger({
  items,
  headingLevel = 2,
  className,
}: SignalLedgerProps): React.ReactElement {
  const t = useT();
  const titleId = useId();
  const PanelHeading = `h${headingLevel}` as 'h2' | 'h3';
  const ItemHeading = `h${(headingLevel + 1) as 3 | 4}` as 'h3' | 'h4';

  return (
    <section
      aria-labelledby={titleId}
      className={cn('flex flex-col gap-4 rounded-lg border border-line bg-canvas p-4', className)}
    >
      <header className="flex flex-col gap-1">
        <PanelHeading
          id={titleId}
          className="flex items-center gap-2 text-lg font-semibold text-ink"
        >
          <Icon name="eye" className="size-5 text-ink-muted" />
          {t('signalLedger.title', 'Your signal ledger')}
        </PanelHeading>
        {/* States plainly that this is private and explains what it is — never a
            leaderboard. */}
        <p className="text-sm text-ink-muted">
          {t(
            'signalLedger.description',
            'A private record of how you engaged. Only you can see this, and it never shows a score or rank.',
          )}
        </p>
        {/* The act → ledger feedback loop is hourly — say so, so an entry that
            has not appeared yet reads as "counted soon", not "broken". */}
        <p className="text-xs text-ink-muted">
          {t('signalLedger.cadence', 'Your activity is counted about once an hour.')}
        </p>
      </header>

      {items.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {t('signalLedger.empty', 'No activity recorded yet.')}
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map((item) => {
            const itemTitleId = `${titleId}-item-${item.id}`;
            return (
              <li
                key={item.id}
                aria-labelledby={itemTitleId}
                className="flex flex-col gap-2 border-line border-t pt-4 first:border-t-0 first:pt-0"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <ItemHeading id={itemTitleId} className="text-base font-medium text-ink">
                    {item.title}
                  </ItemHeading>
                  {item.recordedAt ? (
                    <time
                      dateTime={item.recordedAt}
                      className="shrink-0 text-xs text-ink-muted tabular-nums"
                    >
                      {relativeTimeShort(item.recordedAt)}
                    </time>
                  ) : null}
                </div>
                {item.summary ? <p className="text-sm text-ink-muted">{item.summary}</p> : null}
                <ul className="flex flex-col gap-1">
                  {item.signals.map((signal) => {
                    const copy = SIGNAL_COPY[signal];
                    return (
                      <li key={signal} className="flex items-center gap-2 text-sm text-ink">
                        <Icon name="check-circle" className="size-4 shrink-0 text-success" />
                        <span>{t(copy.key, copy.text)}</span>
                      </li>
                    );
                  })}
                  {item.capReached ? (
                    <li className="flex items-center gap-2 text-sm text-ink-muted">
                      <Icon name="circle-info" className="size-4 shrink-0 text-info" />
                      <span>
                        {t(
                          'signalLedger.signal.capReached',
                          'Counting stopped (per-item limit reached)',
                        )}
                      </span>
                    </li>
                  ) : null}
                  {/* Anti-signals: why something counted LESS — qualitative,
                      distinct from the positive checklist above. */}
                  {(item.antiSignals ?? []).map((antiSignal) => {
                    const copy = ANTI_SIGNAL_COPY[antiSignal];
                    return (
                      <li
                        key={antiSignal}
                        className="flex items-center gap-2 text-sm text-ink-muted"
                      >
                        <Icon name="circle-info" className="size-4 shrink-0 text-ink-muted" />
                        <span>{t(copy.key, copy.text)}</span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
