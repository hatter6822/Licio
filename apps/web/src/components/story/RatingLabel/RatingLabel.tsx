// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rating labels (WS-B.2.3 / Section 5.6). The no-applause replacement for
// likes/scores: each label describes *conversation state*, never popularity.
// Every label carries THREE redundant signals — colour, icon, and text — so
// colour is never the sole differentiator (WCAG 1.4.1). Where two labels share
// a base hue, the icon and text disambiguate and the soft/on-soft tints differ.
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Icon, type IconName } from '../../ui/Icon/index.js';

export type RatingLabelKind =
  | 'new'
  | 'getting-attention'
  | 'deepening'
  | 'well-sourced'
  | 'needs-context'
  | 'under-review'
  | 'resolved-context'
  | 'bridge-active';

interface RatingLabelDescriptor {
  /** soft background + on-soft foreground (text + icon), ≥4.5:1 (verified). */
  classes: string;
  icon: IconName;
  messageKey: string;
  defaultText: string;
}

export const ratingLabels: Record<RatingLabelKind, RatingLabelDescriptor> = {
  // The neutral floor (§5.6): a story with no active-reading signal yet. Plain
  // ink-on-surface (no hue), so it reads as "nothing to claim yet", never a
  // score or a warning.
  new: {
    classes: 'bg-surface text-ink',
    icon: 'circle-info',
    messageKey: 'rating.new',
    defaultText: 'New',
  },
  'getting-attention': {
    classes: 'bg-info-soft text-info-on-soft',
    icon: 'trending-up',
    messageKey: 'rating.gettingAttention',
    defaultText: 'Getting Attention',
  },
  deepening: {
    classes: 'bg-primary-soft text-primary-on-soft',
    icon: 'layers',
    messageKey: 'rating.deepening',
    defaultText: 'Deepening',
  },
  'well-sourced': {
    classes: 'bg-success-soft text-success-on-soft',
    icon: 'document-check',
    messageKey: 'rating.wellSourced',
    defaultText: 'Well-Sourced',
  },
  'needs-context': {
    classes: 'bg-warning-soft text-warning-on-soft',
    icon: 'circle-question',
    messageKey: 'rating.needsContext',
    defaultText: 'Needs Context',
  },
  // The three "distinct shade" labels share a base hue with a sibling but use a
  // SOLID fill (vs the sibling's soft tint), so the two chips are ≥3:1 distinct
  // in lightness for low-vision users (WS-B.2.3) — verified in RatingLabel.test.
  'under-review': {
    classes: 'bg-warning text-warning-fg',
    icon: 'eye',
    messageKey: 'rating.underReview',
    defaultText: 'Under Review',
  },
  'resolved-context': {
    classes: 'bg-success text-success-fg',
    icon: 'check-badge',
    messageKey: 'rating.resolvedContext',
    defaultText: 'Resolved Context',
  },
  'bridge-active': {
    classes: 'bg-info text-info-fg',
    icon: 'bridge',
    messageKey: 'rating.bridgeActive',
    defaultText: 'Bridge Active',
  },
};

export const ratingLabelKinds = Object.keys(ratingLabels) as RatingLabelKind[];

export interface RatingLabelProps {
  kind: RatingLabelKind;
  className?: string;
}

export function RatingLabel({ kind, className }: RatingLabelProps): React.ReactElement {
  const t = useT();
  const descriptor = ratingLabels[kind];
  const text = t(descriptor.messageKey, descriptor.defaultText);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        descriptor.classes,
        className,
      )}
    >
      {/* Decorative: the text label below is the accessible name. */}
      <Icon name={descriptor.icon} className="size-3.5" />
      <span>{text}</span>
    </span>
  );
}
