// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Feed-mode switcher (WS-B.2.9). Lets the reader choose how the feed is ordered
// without any popularity/applause signal. Built on the `Select` primitive: the
// current mode is shown on the trigger and the chosen option carries
// aria-selected, so no separate live region is needed. The "Feed order" field
// label is VISUALLY HIDDEN (`hideLabel`) — the trigger already names the control
// for sighted users, keeping the surface (front-page header / settings) clean —
// but it stays in the DOM as the select's accessible name for assistive tech.
// Presentation only — the controlled `value`/`onValueChange` are owned by the
// caller; persistence is WS-C.
import { useT } from '../../../i18n/index.js';
import { Select, type SelectOption } from '../../ui/Select/index.js';

export type FeedMode =
  | 'balanced'
  | 'chronological'
  | 'source-diverse'
  | 'local'
  | 'low-personalization';

/** Default mode when the reader has expressed no preference. */
export const DEFAULT_FEED_MODE: FeedMode = 'balanced';

export interface FeedModeSwitcherProps {
  /** Controlled, currently-selected feed mode. */
  value: FeedMode;
  onValueChange: (value: FeedMode) => void;
  /** Explicit id for the underlying control; auto-generated when omitted. */
  id?: string;
  disabled?: boolean;
  className?: string;
}

// Order: default first, then the alternative ordering strategies.
const MODE_COPY: ReadonlyArray<{ value: FeedMode; key: string; text: string }> = [
  { value: 'balanced', key: 'feed.mode.balanced', text: 'Balanced' },
  { value: 'chronological', key: 'feed.mode.chronological', text: 'Chronological' },
  { value: 'source-diverse', key: 'feed.mode.sourceDiverse', text: 'Source-diverse' },
  { value: 'local', key: 'feed.mode.local', text: 'Local' },
  {
    value: 'low-personalization',
    key: 'feed.mode.lowPersonalization',
    text: 'Low personalization',
  },
];

export function FeedModeSwitcher({
  value,
  onValueChange,
  id,
  disabled = false,
  className,
}: FeedModeSwitcherProps): React.ReactElement {
  const t = useT();

  const options: SelectOption[] = MODE_COPY.map((mode) => ({
    value: mode.value,
    label: t(mode.key, mode.text),
  }));

  return (
    <Select
      {...(id !== undefined ? { id } : {})}
      label={t('feed.mode.label', 'Feed order')}
      hideLabel
      value={value}
      onValueChange={(next) => onValueChange(next as FeedMode)}
      options={options}
      disabled={disabled}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
