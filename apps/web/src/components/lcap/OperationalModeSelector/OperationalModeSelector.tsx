// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.2 — the §33 connection-mode selector.  One user-selectable mode drives the
// whole client posture: the §21.3 storage policy, the highest priority class admitted,
// whether media is fetched, the discovery/advertising/background-sync channels, and the
// export posture.
//
// UX: the six modes are grouped by the INTENT a user brings (everyday / carry for others /
// low profile) so the choice reads as a small, comparable set rather than a flat list.
// Each mode is a real WAI-ARIA radio (a single tab stop + arrow-key roving selection, per
// the APG radio pattern) showing its name, a one-line summary, and compact posture chips
// (each an icon + text, so the comparison never rests on colour alone); selecting one
// reveals the FULL, honest per-axis breakdown below (media / discovery / re-sharing /
// background sync / offline cache / content kept / exports) — the fine-grain view, derived
// from the real config so it can never drift from what the mode actually does.
//
// HONEST COPY: the selector never claims a mode is "secure"/"private"/"safe" — it states
// exactly what each mode does (and does NOT do).  A mode that warrants a caveat shows a
// PROMINENT warning whose text matches the mode's actual risk (a sharing mode's caveat is
// battery/storage/re-sharing; a low-profile mode's caveat is that reduced exposure is not
// protection).  This is an always-available surface that mirrors the mode state locally
// (no `@licio/lcap` codec import), keeping it off the lazy bundle-codec chunk.

import { type KeyboardEvent, useCallback, useId, useRef, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { getOperationalMode, setOperationalMode } from '../../../lcap/mode-state.js';
import {
  type OperationalMode,
  type OperationalModeConfig,
  operationalMode,
  storageConfigForMode,
} from '../../../lcap/operational-modes.js';
import { cn } from '../../../lib/cn.js';
import { Badge } from '../../ui/Badge/index.js';
import { Icon, type IconName } from '../../ui/Icon/index.js';

type Translate = ReturnType<typeof useT>;

/** The honest, content-free label + one-line summary for each mode (no false trust words). */
interface ModeCopy {
  readonly labelKey: string;
  readonly label: string;
  readonly summaryKey: string;
  readonly summary: string;
}

const MODE_COPY: Readonly<Record<OperationalMode, ModeCopy>> = {
  minimal: {
    labelKey: 'lcap.mode.minimal.label',
    label: 'Minimal',
    summaryKey: 'lcap.mode.minimal.summary',
    summary: 'Essential text only, no media prefetch, aggressive cleanup of old content.',
  },
  standard: {
    labelKey: 'lcap.mode.standard.label',
    label: 'Standard',
    summaryKey: 'lcap.mode.standard.summary',
    summary: 'Text plus thumbnails for the rooms you follow; the everyday balance.',
  },
  courier: {
    labelKey: 'lcap.mode.courier.label',
    label: 'Courier',
    summaryKey: 'lcap.mode.courier.summary',
    summary: 'Carries and re-shares public content for others. Uses more storage and battery.',
  },
  relay: {
    labelKey: 'lcap.mode.relay.label',
    label: 'Relay',
    summaryKey: 'lcap.mode.relay.summary',
    summary: 'Operator mode: stores and forwards content for many peers.',
  },
  stealth: {
    labelKey: 'lcap.mode.stealth.label',
    label: 'Stealth',
    summaryKey: 'lcap.mode.stealth.summary',
    summary:
      'No automatic discovery, advertising, or background sync; manual sync only; generic export filenames; small cache.',
  },
  emergency: {
    labelKey: 'lcap.mode.emergency.label',
    label: 'Emergency',
    summaryKey: 'lcap.mode.emergency.summary',
    summary:
      'Text and control messages only — all media off — and a one-tap export of a chosen public thread.',
  },
};

/** The six modes grouped by the intent a user brings, in essential → sharing → low-profile order. */
interface ModeGroup {
  readonly id: string;
  readonly labelKey: string;
  readonly label: string;
  readonly modes: readonly OperationalMode[];
}

const MODE_GROUPS: readonly ModeGroup[] = [
  {
    id: 'everyday',
    labelKey: 'lcap.mode.group.everyday',
    label: 'Everyday',
    modes: ['minimal', 'standard'],
  },
  {
    id: 'sharing',
    labelKey: 'lcap.mode.group.sharing',
    label: 'Carry for others',
    modes: ['courier', 'relay'],
  },
  {
    id: 'lowProfile',
    labelKey: 'lcap.mode.group.lowProfile',
    label: 'Low profile',
    modes: ['stealth', 'emergency'],
  },
];

/** The flat mode order the roving radiogroup navigates (matches the visual order). */
const FLAT_MODES: readonly OperationalMode[] = MODE_GROUPS.flatMap((group) => group.modes);

/** Format a cache byte budget as a compact human size (250 MB, 2 GB). */
function formatCacheSize(bytes: number): string {
  const GB = 1024 * 1024 * 1024;
  if (bytes >= GB) {
    const gb = bytes / GB;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * The honest media state for a mode — three states, not a boolean.  `mediaAllowed` marks
 * FULL media prefetch; a mode with only `prefetch.thumbnails` (e.g. Standard) truthfully
 * reads "Thumbnails only" rather than the misleading "off" a boolean would show.
 */
function mediaLabel(mode: OperationalMode, t: Translate): string {
  if (operationalMode(mode).mediaAllowed) return t('lcap.mode.media.full', 'Full media');
  return storageConfigForMode(mode).prefetch.thumbnails
    ? t('lcap.mode.media.thumbnails', 'Thumbnails only')
    : t('lcap.mode.media.text', 'Text only');
}

/** The content-priority reach a mode admits, in plain language. */
function priorityReach(config: OperationalModeConfig, t: Translate): string {
  if (config.maxPriority <= 1) return t('lcap.mode.priority.essential', 'Essential only');
  if (config.maxPriority <= 2) return t('lcap.mode.priority.standard', 'Essential + standard');
  return t('lcap.mode.priority.all', 'All content');
}

/** A compact per-card posture chip — an icon (second, non-colour cue) plus plain text. */
interface ModeChip {
  readonly icon: IconName;
  readonly text: string;
}

/** The three network/data-exposure axes shown on every card, so modes compare at a glance. */
function cardChips(mode: OperationalMode, t: Translate): readonly ModeChip[] {
  const config = operationalMode(mode);
  return [
    { icon: 'eye', text: mediaLabel(mode, t) },
    config.autoDiscovery
      ? { icon: 'globe', text: t('lcap.mode.chip.discovery.on', 'Auto-discovery on') }
      : { icon: 'wifi-off', text: t('lcap.mode.chip.discovery.off', 'Auto-discovery off') },
    config.courierAdvertising
      ? { icon: 'bridge', text: t('lcap.mode.chip.sharing.on', 'Re-shares content') }
      : { icon: 'bridge', text: t('lcap.mode.chip.sharing.off', 'No re-sharing') },
  ];
}

/** One row of the fine-grain posture breakdown shown for the active mode. */
interface PostureRow {
  readonly icon: IconName;
  readonly term: string;
  readonly value: string;
}

/** The full, honest per-axis posture for a mode — every value derived from the real config. */
function postureRows(mode: OperationalMode, t: Translate): readonly PostureRow[] {
  const config = operationalMode(mode);
  const storage = storageConfigForMode(mode);
  const onOff = (on: boolean): string =>
    on ? t('lcap.mode.axis.on', 'On') : t('lcap.mode.axis.off', 'Off');
  return [
    { icon: 'eye', term: t('lcap.mode.axis.media', 'Media'), value: mediaLabel(mode, t) },
    {
      icon: 'globe',
      term: t('lcap.mode.axis.discovery', 'Auto-discovery'),
      value: onOff(config.autoDiscovery),
    },
    {
      icon: 'bridge',
      term: t('lcap.mode.axis.sharing', 'Re-shares to nearby devices'),
      value: onOff(config.courierAdvertising),
    },
    {
      icon: 'refresh',
      term: t('lcap.mode.axis.bgSync', 'Background sync'),
      value: onOff(config.backgroundSync),
    },
    {
      icon: 'layers',
      term: t('lcap.mode.axis.storage', 'Offline cache'),
      value: t('lcap.mode.axis.storage.value', 'Up to {size}', {
        size: formatCacheSize(storage.maxBytes),
      }),
    },
    {
      icon: 'document-check',
      term: t('lcap.mode.axis.priority', 'Content kept'),
      value: priorityReach(config, t),
    },
    {
      icon: 'external-link',
      term: t('lcap.mode.axis.export', 'Exports'),
      value: config.confirmBeforeExport
        ? t('lcap.mode.axis.export.confirm', 'Confirm first, generic filename')
        : t('lcap.mode.axis.export.normal', 'Normal'),
    },
  ];
}

/** The risk CLASS a warning belongs to — a sharing mode's caveat differs from a low-profile mode's. */
function warnClass(mode: OperationalMode): 'resource' | 'exposure' {
  return mode === 'courier' || mode === 'relay' ? 'resource' : 'exposure';
}

/** The heading for the active mode's caveat, matched to its risk class. */
function warningHeading(mode: OperationalMode, t: Translate): string {
  return warnClass(mode) === 'resource'
    ? t('lcap.mode.warn.resource.heading', 'Before you turn this on')
    : t('lcap.mode.warn.exposure.heading', 'What this mode does not do');
}

/** The honest caveat body, matched to the mode's actual risk (never a one-size non-sequitur). */
function warningBody(mode: OperationalMode, t: Translate): string {
  return warnClass(mode) === 'resource'
    ? t(
        'lcap.mode.warn.resource.body',
        'This mode carries and re-shares other people’s public content for nearby devices, and uses more battery and storage. It is not anonymity: nearby devices can see this one is sharing. The nearby courier only re-shares public content — never members-only rooms or your attention data; your own content still syncs through the server as usual.',
      )
    : t(
        'lcap.mode.warn.exposure.body',
        'This mode reduces automatic exposure on this device. It is not anonymity and does not protect against a hostile peer, network observer, or a compromised device. Verify who you exchange content with.',
      );
}

export interface OperationalModeSelectorProps {
  /** Notify a parent when the mode changes (e.g. to re-derive a dependent surface). */
  readonly onModeChange?: (mode: OperationalMode) => void;
  readonly className?: string;
}

export function OperationalModeSelector({
  onModeChange,
  className,
}: OperationalModeSelectorProps): React.ReactElement {
  const t = useT();
  const [mode, setMode] = useState<OperationalMode>(() => getOperationalMode());
  // One ref per radio (flat index) so arrow navigation can move DOM focus (APG roving tabindex).
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // A stable id base so each intent subgroup's label can name its `role="group"`.
  const groupIdBase = useId();

  const choose = useCallback(
    (next: OperationalMode) => {
      setOperationalMode(next);
      setMode(next);
      onModeChange?.(next);
    },
    [onModeChange],
  );

  // Roving tabindex: exactly one radio is tabbable (the selected one — there is always a
  // selection, defaulting to Standard), and arrows then move focus AND selection.
  const tabbableIndex = Math.max(0, FLAT_MODES.indexOf(mode));

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      let next = index;
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowRight':
          next = (index + 1) % FLAT_MODES.length;
          break;
        case 'ArrowUp':
        case 'ArrowLeft':
          next = (index - 1 + FLAT_MODES.length) % FLAT_MODES.length;
          break;
        case ' ':
        case 'Enter': {
          event.preventDefault();
          const current = FLAT_MODES[index];
          if (current) choose(current);
          return;
        }
        default:
          return;
      }
      // Arrow keys move focus AND selection in a single-select radio group (APG).
      event.preventDefault();
      const target = FLAT_MODES[next];
      if (!target) return;
      choose(target);
      buttonRefs.current[next]?.focus();
    },
    [choose],
  );

  const activeConfig = operationalMode(mode);
  const rows = postureRows(mode, t);

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div
        role="radiogroup"
        aria-label={t('lcap.mode.groupLabel', 'Connection mode')}
        className="flex flex-col gap-4"
      >
        {MODE_GROUPS.map((group) => {
          const groupLabelId = `${groupIdBase}-${group.id}`;
          return (
            <div
              key={group.id}
              role="group"
              aria-labelledby={groupLabelId}
              className="flex flex-col gap-2"
            >
              {/* The intent label names this subgroup for assistive tech too (role="group" +
                  aria-labelledby), so a screen-reader user gets the same Everyday / Carry for
                  others / Low profile organization as a sighted user — not one flat list. */}
              <p
                id={groupLabelId}
                className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-muted"
              >
                {t(group.labelKey, group.label)}
              </p>
              {group.modes.map((key) => {
                const copy = MODE_COPY[key];
                const config = operationalMode(key);
                const selected = key === mode;
                const flatIndex = FLAT_MODES.indexOf(key);
                return (
                  <button
                    key={key}
                    ref={(node) => {
                      buttonRefs.current[flatIndex] = node;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={flatIndex === tabbableIndex ? 0 : -1}
                    onClick={() => choose(key)}
                    onKeyDown={(event) => handleKeyDown(event, flatIndex)}
                    className={cn(
                      'flex w-full flex-col gap-2 rounded-lg border p-3 text-start',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                      selected ? 'border-primary bg-surface-sunken' : 'border-line bg-canvas',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      {/* A real radio indicator (ring + filled dot), never a help-looking icon. */}
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex size-5 shrink-0 items-center justify-center rounded-full border',
                          selected ? 'border-primary text-primary' : 'border-line-strong',
                        )}
                      >
                        {selected ? <span className="size-2.5 rounded-full bg-current" /> : null}
                      </span>
                      <span className="font-medium text-ink">{t(copy.labelKey, copy.label)}</span>
                      {/* A calm "read the caveat" cue — never the alarming "High-risk", which
                        overstates a sharing mode's (battery/storage) cost. */}
                      {config.showTrustWarning ? (
                        <Badge tone="warning">{t('lcap.mode.readFirst', 'Read before use')}</Badge>
                      ) : null}
                    </span>
                    <span className="text-sm text-ink-muted">
                      {t(copy.summaryKey, copy.summary)}
                    </span>
                    <span className="flex flex-wrap gap-1.5">
                      {cardChips(key, t).map((chip) => (
                        <Badge key={chip.text} tone="neutral" icon={chip.icon}>
                          {chip.text}
                        </Badge>
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* The PROMINENT caveat for the active mode, matched to its real risk class (§26.3).
          `key={mode}` remounts it on a warn→warn switch so a screen reader re-announces. */}
      {activeConfig.showTrustWarning ? (
        <div
          key={mode}
          role="alert"
          className="flex flex-col gap-1 rounded-lg bg-warning-soft p-3 text-warning-on-soft"
        >
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Icon name="triangle-exclamation" className="size-4" />
            {warningHeading(mode, t)}
          </p>
          <p className="text-sm">{warningBody(mode, t)}</p>
        </div>
      ) : null}

      {/* The fine-grain posture for the active mode — every value derived from the real config. */}
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-canvas p-3">
        <p className="text-sm font-medium text-ink">
          {t('lcap.mode.postureHeading', 'What this mode does on this device')}
        </p>
        <dl className="flex flex-col gap-1.5 text-sm">
          {rows.map((row) => (
            <div key={row.term} className="flex items-start justify-between gap-3">
              <dt className="flex items-center gap-2 text-ink-muted">
                <Icon name={row.icon} className="size-4 text-ink-muted" />
                {row.term}
              </dt>
              <dd className="text-end font-medium text-ink">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
