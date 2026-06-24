// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.2 — the §33 operational-mode selector.  One user-selectable mode drives the
// whole client posture (storage, the highest priority class admitted, whether media is
// fetched, the discovery/advertising/background-sync channels, and the export posture).
// This is the documented WS-R.17.2 follow-up: a Stealth/Emergency control may ship now
// because the posture it implies IS wired (the §23.3 sync gate reads `syncStorageMode`,
// the media/discovery/export surfaces read the per-mode derived helpers).
//
// HONEST COPY: the selector never claims a mode is "secure"/"private"/"safe" — it states
// exactly what each mode does (and does NOT do).  A high-risk mode (`showTrustWarning`)
// shows a PROMINENT warning so the user is not misled about its protection.  This is an
// always-available surface that mirrors the mode state locally (no `@licio/lcap` codec
// import), keeping it off the lazy bundle-codec chunk.

import { useCallback, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { getOperationalMode, setOperationalMode } from '../../../lcap/mode-state.js';
import {
  OPERATIONAL_MODE_KEYS,
  type OperationalMode,
  operationalMode,
} from '../../../lcap/operational-modes.js';
import { cn } from '../../../lib/cn.js';
import { Badge } from '../../ui/Badge/index.js';
import { Icon } from '../../ui/Icon/index.js';

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

/** A concise posture line built from the actual mode config (never a fixed claim). */
function postureFacts(mode: OperationalMode, t: ReturnType<typeof useT>): string[] {
  const config = operationalMode(mode);
  return [
    config.mediaAllowed
      ? t('lcap.mode.fact.media.on', 'Media: prefetched')
      : t('lcap.mode.fact.media.off', 'Media: off (open individually)'),
    config.autoDiscovery
      ? t('lcap.mode.fact.discovery.on', 'Discovery: automatic')
      : t('lcap.mode.fact.discovery.off', 'Discovery: off'),
    config.backgroundSync
      ? t('lcap.mode.fact.bg.on', 'Background sync: on')
      : t('lcap.mode.fact.bg.off', 'Background sync: off'),
    config.confirmBeforeExport
      ? t('lcap.mode.fact.export.confirm', 'Export: confirm + generic filename')
      : t('lcap.mode.fact.export.normal', 'Export: normal'),
  ];
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

  const choose = useCallback(
    (next: OperationalMode) => {
      setOperationalMode(next);
      setMode(next);
      onModeChange?.(next);
    },
    [onModeChange],
  );

  const activeConfig = operationalMode(mode);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div role="radiogroup" aria-label={t('lcap.mode.groupLabel', 'Operational mode')}>
        <ul className="flex flex-col gap-2">
          {OPERATIONAL_MODE_KEYS.map((key) => {
            const copy = MODE_COPY[key];
            const config = operationalMode(key);
            const selected = key === mode;
            return (
              <li key={key}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => choose(key)}
                  className={cn(
                    'flex w-full flex-col items-start gap-1 rounded-lg border p-3 text-left',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                    selected ? 'border-focus bg-surface-sunken' : 'border-line bg-canvas',
                  )}
                >
                  <span className="flex items-center gap-2">
                    {selected ? (
                      <Icon name="check-circle" className="size-4 text-ink" />
                    ) : (
                      <Icon name="circle-info" className="size-4 text-ink-muted" />
                    )}
                    <span className="font-medium text-ink">{t(copy.labelKey, copy.label)}</span>
                    {config.showTrustWarning ? (
                      <Badge tone="warning">{t('lcap.mode.highRisk', 'High-risk')}</Badge>
                    ) : null}
                  </span>
                  <span className="text-sm text-ink-muted">{t(copy.summaryKey, copy.summary)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* The PROMINENT trust warning for the active high-risk mode (§26.3). Honest: it
          states the limit, never a protection the client does not deliver. */}
      {activeConfig.showTrustWarning ? (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-lg bg-warning-soft p-3 text-warning-on-soft"
        >
          <Badge tone="warning">
            {t('lcap.mode.warningHeading', 'What this mode does not do')}
          </Badge>
          <p className="text-sm">
            {t(
              'lcap.mode.warningBody',
              'This mode reduces automatic exposure on this device. It is not anonymity and does not protect against a hostile peer, network observer, or a compromised device. Verify who you exchange content with.',
            )}
          </p>
        </div>
      ) : null}

      {/* The posture facts for the active mode — derived from the real config. */}
      <ul aria-label={t('lcap.mode.factsLabel', 'This mode')} className="flex flex-col gap-1">
        {postureFacts(mode, t).map((fact) => (
          <li key={fact} className="text-xs text-ink-muted">
            {fact}
          </li>
        ))}
      </ul>
    </div>
  );
}
