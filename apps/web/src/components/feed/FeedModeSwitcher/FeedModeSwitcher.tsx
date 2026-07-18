// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Feed-mode switcher (WS-B.2.9; SPEC §11.6). Lets the reader choose how the
// feed is SORTED — five objective, content-derived orders, none of them a
// popularity/applause signal: Best (highest participation-weighted attention
// right now), Rising (fastest-increasing attention), Sources (most sourced
// comments), Debates (most WS-T debates), New (most recent). Built on the
// `Select` primitive: the current mode is shown on the trigger and the chosen
// option carries aria-selected, so no separate live region is needed. The
// "Sort by" field label is VISUALLY HIDDEN (`hideLabel`) — the trigger already
// names the control for sighted users, keeping the surface (front-page header
// / settings) clean — but it stays in the DOM as the select's accessible name
// for assistive tech. Presentation only — the controlled
// `value`/`onValueChange` are owned by the caller; persistence is WS-C.
import { DEFAULT_FEED_MODE, FEED_MODES, type FeedMode } from '@licio/shared';
import { useT } from '../../../i18n/index.js';
import { Select, type SelectOption } from '../../ui/Select/index.js';

// The canonical mode set + default live in @licio/shared (the schema the
// server validates against); re-exported here for existing importers.
export { DEFAULT_FEED_MODE, FEED_MODES, type FeedMode };

export interface FeedModeSwitcherProps {
  /** Controlled, currently-selected feed mode. */
  value: FeedMode;
  onValueChange: (value: FeedMode) => void;
  /** Explicit id for the underlying control; auto-generated when omitted. */
  id?: string;
  disabled?: boolean;
  className?: string;
}

// Order: default first, then the alternative sort orders.
const MODE_COPY: ReadonlyArray<{ value: FeedMode; key: string; text: string }> = [
  { value: 'best', key: 'feed.mode.best', text: 'Best' },
  { value: 'rising', key: 'feed.mode.rising', text: 'Rising' },
  { value: 'sources', key: 'feed.mode.sources', text: 'Sources' },
  { value: 'debates', key: 'feed.mode.debates', text: 'Debates' },
  { value: 'new', key: 'feed.mode.new', text: 'New' },
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
      label={t('feed.mode.label', 'Sort by')}
      hideLabel
      value={value}
      onValueChange={(next) => onValueChange(next as FeedMode)}
      options={options}
      disabled={disabled}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
