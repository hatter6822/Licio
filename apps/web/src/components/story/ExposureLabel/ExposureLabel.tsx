// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MERI exposure labels (WS-H.2.3a, SPEC §7.6): "Independent source",
// "New angle", "Same claim, new evidence", "Duplicate context". Labels
// describe EXPOSURE NONREDUNDANCY only — the app never says "true because
// many outlets repeated it" — and `duplicate_context` is meant for
// topic-page lineage surfaces, not feed cards. Icon + text always pair
// (never colour alone), mirroring the RatingLabel conventions.

import type { MeriExposureLabelWire } from '@licio/shared';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Icon, type IconName } from '../../ui/Icon/index.js';

interface ExposureLabelDescriptor {
  icon: IconName;
  messageKey: string;
  defaultText: string;
  classes: string;
}

export const exposureLabels: Record<MeriExposureLabelWire, ExposureLabelDescriptor> = {
  independent_source: {
    icon: 'check-badge',
    messageKey: 'exposure.independentSource',
    defaultText: 'Independent source',
    classes: 'bg-success-soft text-success-on-soft',
  },
  new_angle: {
    icon: 'trending-up',
    messageKey: 'exposure.newAngle',
    defaultText: 'New angle',
    classes: 'bg-primary-soft text-primary-on-soft',
  },
  same_claim_new_evidence: {
    icon: 'document-check',
    messageKey: 'exposure.sameClaimNewEvidence',
    defaultText: 'Same claim, new evidence',
    classes: 'bg-info-soft text-info-on-soft',
  },
  duplicate_context: {
    icon: 'circle-info',
    messageKey: 'exposure.duplicateContext',
    defaultText: 'Duplicate context',
    classes: 'bg-warning-soft text-warning-on-soft',
  },
};

export const exposureLabelKinds = Object.keys(exposureLabels) as MeriExposureLabelWire[];

export interface ExposureLabelProps {
  label: MeriExposureLabelWire;
  className?: string;
}

export function ExposureLabel({ label, className }: ExposureLabelProps): React.ReactElement {
  const t = useT();
  const descriptor = exposureLabels[label];
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
      <span>{t(descriptor.messageKey, descriptor.defaultText)}</span>
    </span>
  );
}
