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
// A fourth, TERMINAL presentation rides orthogonally to the status:
//   • "Settled"   (`dispute_settled`) — the content prevailed in ENOUGH sourced
//       debates (the challenge-policy settle threshold, SPEC §15.4) that it can
//       no longer be challenged. It always co-occurs with `validated` (only an
//       upheld defense settles), and it SUPERSEDES the plain "Validated" chip:
//       "Settled" is the stronger, no-longer-challengeable form of the same
//       positive integrity outcome. Still no penalty, still never applause.
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
    chip: 'border-warning/50 text-warning-on-soft',
    banner: 'bg-warning-soft text-warning-on-soft',
    edge: 'border-warning/60',
    icon: 'flag',
    explanation:
      'A sourced correction has opened an open debate — both sides are making their case.',
  },
  incorrect: {
    label: 'Incorrect',
    chip: 'border-error/60 text-error-on-soft',
    banner: 'bg-error-soft text-error-on-soft',
    edge: 'border-error/60',
    icon: 'flag',
    explanation:
      'A sourced correction prevailed in an open debate. It is demoted and kept for the record.',
  },
  validated: {
    label: 'Validated',
    chip: 'border-success/60 text-success-on-soft',
    banner: 'bg-success-soft text-success-on-soft',
    edge: 'border-success/60',
    icon: 'check-circle',
    explanation:
      'A sourced correction was reviewed and did not hold — this was challenged and stands as accurate.',
  },
};

/**
 * The TERMINAL "Settled" presentation (SPEC §15.4). It is not a `dispute_status`
 * value — settling is carried by the separate `dispute_settled` wire marker so a
 * pre-settle cached bundle's strict enum never has to parse a new status — so it
 * lives outside {@link DISPUTE_META}, keyed by the boolean rather than the enum.
 * Success-family tone (settled is a stronger `validated`) with its own label,
 * seal icon, and explanation carrying the load-bearing distinction: challenged,
 * upheld, and now beyond challenge.
 */
const SETTLED_META: DisputeMeta = {
  label: 'Settled',
  chip: 'border-success/60 text-success-on-soft',
  banner: 'bg-success-soft text-success-on-soft',
  edge: 'border-success/60',
  icon: 'check-badge',
  explanation:
    'Sourced corrections were reviewed and did not hold enough times that this is now established — it can no longer be challenged.',
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
 * `settled` supersedes the status hue (a settled item is always `validated`, so
 * this only ever swaps one success edge for the settled success edge).
 *
 * Never the SOLE carrier of meaning (WS-B.1.1f): the card always renders the
 * DisputeBadge with the same state in text, and the tinted edge flattens with
 * every other decorative treatment under forced colours.
 */
export function disputeBorderClass(status: DisputeStatus, settled = false): string | null {
  if (settled) return SETTLED_META.edge;
  return status === 'none' ? null : DISPUTE_META[status].edge;
}

/**
 * Compact pill for the comment header and the story-card rating row. Renders
 * nothing for `none` (unless `settled`), so callers can mount it
 * unconditionally. `settled` supersedes the status — a settled item shows the
 * terminal "Settled" chip in place of "Validated".
 */
export function DisputeBadge({
  status,
  settled = false,
  className,
}: {
  status: DisputeStatus;
  settled?: boolean;
  className?: string;
}): React.ReactElement | null {
  if (settled) {
    return (
      <span className={cn(CHIP_BASE, SETTLED_META.chip, className)}>{SETTLED_META.label}</span>
    );
  }
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
  settled = false,
  className,
}: {
  status: DisputeStatus;
  settled?: boolean;
  className?: string;
}): React.ReactElement | null {
  if (!settled && status === 'none') return null;
  const meta = settled ? SETTLED_META : DISPUTE_META[status as ActiveDisputeStatus];
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
