// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T dispute-posture badge (SPEC §15.4 / §10.5). A comment OR a story that a
// sourced CORRECTION has challenged shows one of three states:
//   • "Challenged" (`under_debate`) — a debate arena is live.
//   • "Incorrect"  (`incorrect`)    — a correction PREVAILED; the item is demoted
//       (a comment sinks to the bottom of its section, a story to the bottom of
//       the feed via the WS-I dispute ordering sink) but kept visible for record.
//   • "Validated"  (`validated`)    — a challenge was raised and the debate UPHELD
//       the content: challenged and PROVEN ACCURATE. No penalty (a positive
//       content-integrity signal, never applause), still re-challengeable.
//
// Strictly no-applause: these are content-INTEGRITY signals (outcomes of a
// sourced, adjudicated debate), never popularity counts. They are distinct from
// the lens divergence in "Where interpretations differ": no reading there is ever
// labelled this way.
import type { ContributionDisputeStatus } from '@licio/shared';
import { cn } from '../../../lib/cn.js';
import { Icon, type IconName } from '../../ui/Icon/index.js';

/** The dispute vocabulary shared by contributions and stories (identical values
 *  in both DB enums); the badge renders nothing for the undisputed `none`. */
export type DisputeStatus = ContributionDisputeStatus;

type ActiveDisputeStatus = Exclude<DisputeStatus, 'none'>;

interface DisputeMeta {
  label: string;
  /** Chip tone (bordered pill). */
  chip: string;
  /** Banner tone (soft-filled panel). */
  banner: string;
  /** Card EDGE tone — the same hue as this state's chip, at the weight a
   *  full-card outline needs (see {@link disputeBorderClass}). */
  edge: string;
  icon: IconName;
  /** One-line, plain explanation for the banner. */
  explanation: string;
}

const DISPUTE_META: Record<ActiveDisputeStatus, DisputeMeta> = {
  under_debate: {
    label: 'Challenged',
    chip: 'border-warning/50 text-warning',
    banner: 'bg-warning-soft text-warning-on-soft',
    edge: 'border-warning/60',
    icon: 'flag',
    explanation:
      'A sourced correction has opened an open debate — both sides are making their case.',
  },
  incorrect: {
    label: 'Incorrect',
    chip: 'border-error/60 text-error',
    banner: 'bg-error-soft text-error-on-soft',
    edge: 'border-error/60',
    icon: 'flag',
    explanation:
      'A sourced correction prevailed in an open debate. It is demoted and kept for the record.',
  },
  validated: {
    label: 'Validated',
    chip: 'border-success/60 text-success',
    banner: 'bg-success-soft text-success-on-soft',
    edge: 'border-success/60',
    icon: 'check-circle',
    explanation:
      'A sourced correction was reviewed and did not hold — this was challenged and stands as accurate.',
  },
};

const CHIP_BASE =
  'rounded border px-1.5 py-px text-xs font-medium uppercase tracking-wide leading-tight';

/**
 * The border colour a WHOLE CARD takes on while it carries a dispute posture —
 * the same hue as the state's chip, so the card's edge and its label read as
 * one signal and a challenged/corrected/validated story is recognisable while
 * scrolling a feed, before the chip row is read.
 *
 * Null for `none`, so a caller keeps its neutral `border-line`: `cn` does not
 * resolve Tailwind conflicts, so the two border colours must never both be
 * emitted (`cn(..., disputeBorderClass(s) ?? 'border-line')`).
 *
 * Never the SOLE carrier of meaning (WS-B.1.1f): the card always renders the
 * DisputeBadge with the same state in text, and the tinted edge flattens with
 * every other decorative treatment under forced colours.
 */
export function disputeBorderClass(status: DisputeStatus): string | null {
  return status === 'none' ? null : DISPUTE_META[status].edge;
}

/**
 * Compact pill for the comment header and the story-card rating row. Renders
 * nothing for `none`, so callers can mount it unconditionally.
 */
export function DisputeBadge({
  status,
  className,
}: {
  status: DisputeStatus;
  className?: string;
}): React.ReactElement | null {
  if (status === 'none') return null;
  const meta = DISPUTE_META[status];
  return <span className={cn(CHIP_BASE, meta.chip, className)}>{meta.label}</span>;
}

/**
 * A fuller banner for the story detail page: the label plus a one-line, plain
 * explanation of what the state means for the reader. Renders nothing for
 * `none`.
 */
export function DisputeBanner({
  status,
  className,
}: {
  status: DisputeStatus;
  className?: string;
}): React.ReactElement | null {
  if (status === 'none') return null;
  const meta = DISPUTE_META[status];
  return (
    <div
      role="note"
      className={cn('flex items-start gap-2 rounded-lg p-3 text-sm', meta.banner, className)}
    >
      <Icon name={meta.icon} className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>
        <span className="font-semibold">{meta.label}</span> — {meta.explanation}
      </p>
    </div>
  );
}
