// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.1 — the §34 honest trust/liveness badge.  Renders the single honest label
// for a record's (trust §18.2, liveness §20.1) pair via `honestTrustLabel`, so the UI
// NEVER collapses distinct states into one "secure"/"trusted"/"delivered"/"final"/
// "safe" badge.  Icon + text always pair (the text is the accessible name; the icon
// is decorative), mirroring the DisputeBadge/StorySignals conventions.  Uncertain
// states read as caution, hard-negative states as danger — visually distinct and
// explained by their own wording.

import { useT } from '../../../i18n/index.js';
import {
  honestTrustLabel,
  type LcapLivenessState,
  type LcapTrustState,
  type TrustLabelKey,
  type TrustTone,
} from '../../../lcap/trust-labels.js';
import { cn } from '../../../lib/cn.js';
import { Icon, type IconName } from '../../ui/Icon/index.js';

/** Tone → soft chip classes (never colour alone; the text carries the meaning). */
const TONE_CLASSES: Readonly<Record<TrustTone, string>> = {
  neutral: 'bg-surface-sunken text-ink-muted',
  progress: 'bg-info-soft text-info-on-soft',
  positive: 'bg-success-soft text-success-on-soft',
  caution: 'bg-warning-soft text-warning-on-soft',
  danger: 'bg-error-soft text-error-on-soft',
};

interface BadgeDescriptor {
  readonly icon: IconName;
  readonly messageKey: string;
  readonly defaultText: string;
}

/** The §34 honest labels — exact wording, no forbidden trust words (the card's list). */
export const trustBadgeDescriptors: Readonly<Record<TrustLabelKey, BadgeDescriptor>> = {
  saved_on_device: {
    icon: 'wifi-off',
    messageKey: 'lcap.trust.savedOnDevice',
    defaultText: 'Saved on this device',
  },
  queued_for_sync: {
    icon: 'more-horizontal',
    messageKey: 'lcap.trust.queuedForSync',
    defaultText: 'Queued for sync',
  },
  shared_in_export: {
    icon: 'external-link',
    messageKey: 'lcap.trust.sharedInExport',
    defaultText: 'Shared in exported bundle',
  },
  stored_by_relay: {
    icon: 'circle-info',
    messageKey: 'lcap.trust.storedByRelay',
    defaultText: 'Stored by nearby relay',
  },
  received_by_server: {
    icon: 'document-check',
    messageKey: 'lcap.trust.receivedByServer',
    defaultText: 'Received by Licio server',
  },
  accepted_by_room: {
    icon: 'check-circle',
    messageKey: 'lcap.trust.acceptedByRoom',
    defaultText: 'Accepted by room',
  },
  included_in_checkpoint: {
    icon: 'check-badge',
    messageKey: 'lcap.trust.includedInCheckpoint',
    defaultText: 'Included in room checkpoint',
  },
  witnessed_by_watcher: {
    icon: 'check-badge',
    messageKey: 'lcap.trust.witnessedByWatcher',
    defaultText: 'Witnessed by independent watcher',
  },
  verified_local_stale_checkpoint: {
    icon: 'triangle-exclamation',
    messageKey: 'lcap.trust.verifiedLocalStaleCheckpoint',
    defaultText: 'Verified locally, but checkpoint is stale',
  },
  cannot_verify_missing_key: {
    icon: 'circle-question',
    messageKey: 'lcap.trust.cannotVerifyMissingKey',
    defaultText: 'Cannot verify yet: missing key or capability',
  },
  conflict_detected: {
    icon: 'triangle-exclamation',
    messageKey: 'lcap.trust.conflictDetected',
    defaultText: 'Conflict detected',
  },
  revoked: {
    icon: 'octagon-exclamation',
    messageKey: 'lcap.trust.revoked',
    defaultText: 'Revoked',
  },
  rejected_by_room: {
    icon: 'octagon-exclamation',
    messageKey: 'lcap.trust.rejectedByRoom',
    defaultText: 'Rejected by room policy',
  },
};

export interface TrustBadgeProps {
  readonly trust: LcapTrustState;
  readonly liveness: LcapLivenessState;
  readonly className?: string;
}

export function TrustBadge({ trust, liveness, className }: TrustBadgeProps): React.ReactElement {
  const t = useT();
  const { key, tone } = honestTrustLabel(trust, liveness);
  const descriptor = trustBadgeDescriptors[key];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {/* Decorative: the text label is the accessible name. */}
      <Icon name={descriptor.icon} className="size-3.5" />
      <span>{t(descriptor.messageKey, descriptor.defaultText)}</span>
    </span>
  );
}
