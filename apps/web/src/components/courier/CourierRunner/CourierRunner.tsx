// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4c/d/e — the courier RUNTIME driver UI (OFFLINE_SPEC §22.5, §16, §33.5).  This is
// the runtime caller that the §22.5 `CourierControls` editor and the `CourierController`
// orchestration previously lacked: it composes the controls editor with a real Start/Stop
// control that constructs a `CourierController` over the resolved native radio channels
// (Nearby + the WS-R.15.4d Wi-Fi Direct / Bluetooth / USB plugins) and drives live §16
// exchanges over them.
//
// HONEST STATE throughout — never a fabricated "connected"/"secure"/"safe":
//   * Outside the native courier shell (a normal browser), NO native radio resolves, so the
//     control states plainly that the courier needs the installed app and offers no Start.
//   * `decideCourierStart` gates the radios (off by default; Stealth/Emergency force them
//     off; the §22.5 battery floor / who-can-exchange gates); a blocked start surfaces its
//     typed reason verbatim, never a false "running".
//   * Each per-endpoint exchange outcome is reported honestly (which channel carried it, or
//     why it was skipped) — the radio confers NO trust; every received frame is re-checked
//     downstream against its CIDs/COSE signatures (§18.4).
//
// The `CourierController` + the channel resolvers + the frontier-request builder load the
// `@licio/lcap` codec only through a dynamic import (kept off the initial bundle); this
// component imports the controls editor + the channel-info metadata statically (both are
// always-available local surfaces with no codec import).  No `@licio/lcap-p2p` import at all
// (the courier carries no WebRTC) — `check:lcap-p2p-split` is unaffected.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { getOperationalMode, subscribeOperationalMode } from '../../../lcap/mode-state.js';
import type { OperationalMode } from '../../../lcap/operational-modes.js';
import {
  COURIER_CHANNEL_INFO,
  COURIER_CHANNELS,
  type CourierChannel,
} from '../../../lcap/transports/courier-channels.js';
import type { CourierController } from '../../../lcap/transports/courier-controller.js';
import {
  getCourierControls,
  getRadioDisclosureAcknowledged,
  setCourierControls,
} from '../../../lcap/transports/courier-controls-state.js';
import {
  type CourierBlockedReason,
  type CourierMode,
  type CourierRadioControls,
  nearbyCourierAvailable,
} from '../../../lcap/transports/courier-native.js';
import { cn } from '../../../lib/cn.js';
import { Badge } from '../../ui/Badge/index.js';
import { Button } from '../../ui/Button/index.js';
import { Checkbox } from '../../ui/Checkbox/index.js';
import { CourierControls } from '../CourierControls/index.js';

/** The runtime phases the driver surfaces honestly. */
type RunPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'running'; readonly channels: readonly CourierChannel[] }
  | { readonly kind: 'blocked'; readonly reason: CourierBlockedReason }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'error' };

/** A per-endpoint exchange outcome, mirrored locally for the activity log. */
interface ActivityEntry {
  readonly id: number;
  readonly channel: CourierChannel;
  readonly carried: boolean;
  readonly skippedReason: string;
}

/** The operational modes that force the radios off (§33.5). */
function isForcedOff(mode: OperationalMode): boolean {
  return mode === 'stealth' || mode === 'emergency';
}

export interface CourierRunnerProps {
  readonly className?: string;
}

/**
 * The §22.5 courier controls + a runtime Start/Stop driver.  Constructs a real
 * `CourierController` over the resolved native channels and drives live exchanges; honest
 * about availability and every blocked/skipped state.
 */
export function CourierRunner({ className }: CourierRunnerProps): React.ReactElement {
  const t = useT();
  const [controls, setControls] = useState<CourierRadioControls>(() => getCourierControls());
  const [acknowledged, setAcknowledged] = useState<boolean>(() => getRadioDisclosureAcknowledged());
  const [phase, setPhase] = useState<RunPhase>({ kind: 'idle' });
  const [activity, setActivity] = useState<readonly ActivityEntry[]>([]);
  const controllerRef = useRef<CourierController | null>(null);
  const activitySeq = useRef(0);
  // The §33 operational mode — REACTIVE here (unlike the non-reactive sync consumers): switching
  // into Stealth/Emergency must stop a running courier immediately, so we subscribe (below) and
  // re-render on a change.
  const [mode, setRunnerMode] = useState<OperationalMode>(() => getOperationalMode());
  const forcedOff = isForcedOff(mode);

  // Keep `mode` in sync with the persisted §33 mode (the OperationalModeSelector writes it); a
  // change re-renders + re-runs the live-reconcile effect below.
  useEffect(() => subscribeOperationalMode(setRunnerMode), []);

  // Native radios resolve only inside the installed courier shell (the injected Capacitor
  // bridge); a normal browser has none, so the runtime control is honestly disabled.
  const nativeAvailable = useMemo(() => nearbyCourierAvailable(), []);

  // Stop the controller on unmount so a left page never leaves a radio advertising.
  useEffect(() => {
    return () => {
      void controllerRef.current?.stop();
      controllerRef.current = null;
    };
  }, []);

  // If the disclosure is revoked while running, stop immediately (fail-closed).
  useEffect(() => {
    if (!acknowledged && controllerRef.current) {
      void controllerRef.current.stop();
      controllerRef.current = null;
      setPhase({ kind: 'idle' });
    }
  }, [acknowledged]);

  // Apply a live control OR mode change to a RUNNING controller, so a privacy restriction (radios
  // off, a deselected channel, peers→none, or switching into Stealth/Emergency) takes effect
  // IMMEDIATELY instead of only at the next Stop/Start — the controls + mode captured at
  // construction would otherwise keep the radios + exchange policy active until Stop.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    void (async () => {
      // A FRESH power reading so the §22.5 battery floor is enforced against the current level
      // (not the snapshot captured at Start).  The controller module is already loaded (the
      // controller exists), so this dynamic import is a cache hit and keeps the codec off the
      // initial bundle.
      const { readCourierPower } = await import('../../../lcap/transports/courier-controller.js');
      const power = await readCourierPower();
      await controller.applyControls(controls, { power, mode: mode as CourierMode });
      // If applyControls stopped the courier, onDecisionChange already nulled the ref + set the
      // blocked phase; otherwise reflect any live direction/channel change in the running list.
      if (controllerRef.current === controller && controller.isRunning()) {
        setPhase({ kind: 'running', channels: controller.activeChannels() });
      }
    })();
  }, [controls, mode]);

  const onControlsChange = useCallback((next: CourierRadioControls) => {
    setControls(next);
  }, []);

  const toggleChannel = useCallback(
    (channel: CourierChannel, enabled: boolean) => {
      const current = new Set(controls.enabledChannels ?? ['nearby']);
      if (enabled) current.add(channel);
      else current.delete(channel);
      // Never let the selection go empty — fall back to the proven Nearby default.
      const next: CourierRadioControls = {
        ...controls,
        enabledChannels: current.size > 0 ? [...current] : ['nearby'],
      };
      setCourierControls(next);
      setControls(next);
    },
    [controls],
  );

  const start = useCallback(async () => {
    if (!nativeAvailable) {
      setPhase({ kind: 'unavailable' });
      return;
    }
    if (controllerRef.current) return; // already running
    setPhase({ kind: 'starting' });
    setActivity([]);
    try {
      const [
        { CourierController: Controller, readCourierPower },
        { resolveCourierChannels },
        { prepareCourierFrontierRequest },
      ] = await Promise.all([
        import('../../../lcap/transports/courier-controller.js'),
        import('../../../lcap/transports/courier-channels.js'),
        import('../../../lcap/transports/frontier-request.js'),
      ]);
      const channels = resolveCourierChannels(controls.enabledChannels);
      if (channels.length === 0) {
        // The shell is present but no SELECTED radio resolves (e.g. the device lacks it).
        setPhase({ kind: 'unavailable' });
        return;
      }
      const buildRequest = await prepareCourierFrontierRequest();
      const power = await readCourierPower();
      const controller = new Controller({
        channels,
        controls,
        mode: mode as CourierMode,
        power,
        buildRequest,
        onOutcome: (outcome) => {
          setActivity((prev) => [
            ...prev.slice(-19),
            {
              id: activitySeq.current++,
              channel: outcome.channel,
              carried: outcome.carriedBy === 'courier',
              skippedReason: outcome.skippedReason,
            },
          ]);
        },
        // A radio whose native start fails ASYNCHRONOUSLY (the common GMS-Task timing) stops the
        // controller after start() resolved — drop it from "running" instead of showing a stale,
        // already-stopped courier.
        onDecisionChange: (decision) => {
          controllerRef.current = null;
          setPhase({ kind: 'blocked', reason: decision.blockedReason });
        },
      });
      // Make the controller reachable BEFORE awaiting start(), so an unmount, a disclosure
      // revocation, or a live-control change DURING the start (e.g. a pending native start / USB
      // permission prompt) can stop or reconcile it instead of being lost against a stale start.
      controllerRef.current = controller;
      const decision = await controller.start();
      if (!decision.advertise && !decision.discover) {
        // The controls/mode disallowed the radios — surface the typed reason, never "running".
        await controller.stop();
        if (controllerRef.current === controller) controllerRef.current = null;
        setPhase({ kind: 'blocked', reason: decision.blockedReason });
        return;
      }
      if (!controller.isRunning()) {
        // A late start-failure already stopped the controller DURING start() (onDecisionChange set
        // the blocked phase) — don't overwrite it with "running".
        if (controllerRef.current === controller) controllerRef.current = null;
        setPhase({ kind: 'blocked', reason: controller.startDecision().blockedReason });
        return;
      }
      controllerRef.current = controller;
      setPhase({ kind: 'running', channels: controller.activeChannels() });
    } catch {
      // Never leak a partially-constructed controller (a throw mid-start).
      if (controllerRef.current) {
        void controllerRef.current.stop();
        controllerRef.current = null;
      }
      setPhase({ kind: 'error' });
    }
  }, [controls, mode, nativeAvailable]);

  const stop = useCallback(async () => {
    await controllerRef.current?.stop();
    controllerRef.current = null;
    setPhase({ kind: 'idle' });
  }, []);

  const running = phase.kind === 'running';
  // Start is only offered when the disclosure is acknowledged and a radio is enabled, the
  // mode does not force it off, and we are not already running.
  const anyRadioEnabled = controls.advertisingEnabled || controls.discoveryEnabled;
  const canStart = acknowledged && anyRadioEnabled && !forcedOff && !running;

  return (
    <section
      className={cn('flex flex-col gap-5', className)}
      aria-label={t('courier.runner.title', 'Courier')}
    >
      <CourierControls onControlsChange={onControlsChange} onAcknowledgeChange={setAcknowledged} />

      {/* Per-channel selection — only meaningful once the disclosure is acknowledged. */}
      {acknowledged ? (
        <fieldset className="flex flex-col gap-2 border-0 p-0">
          <legend className="text-sm font-medium text-ink">
            {t('courier.channels.legend', 'Which radios to use')}
          </legend>
          <p className="text-xs text-ink-muted">
            {t(
              'courier.channels.intro',
              'Nearby Connections is the proven default. Other radios are used only where your device supports them.',
            )}
          </p>
          {COURIER_CHANNELS.map((channel) => {
            const info = COURIER_CHANNEL_INFO[channel];
            const enabled = (controls.enabledChannels ?? ['nearby']).includes(channel);
            return (
              <div key={channel} className="flex flex-col gap-1">
                <Checkbox
                  checked={enabled}
                  onCheckedChange={(value) => toggleChannel(channel, value)}
                  label={channelLabel(channel, t)}
                />
                <span className="pl-6 text-xs text-ink-muted">
                  {info.verification === 'physical_only'
                    ? t(
                        'courier.channels.physicalOnly',
                        'Cable only — needs a physical USB connection (cannot be verified without hardware).',
                      )
                    : t(`courier.channel.reveals.${channel}`, info.revealsSummary)}
                </span>
              </div>
            );
          })}
        </fieldset>
      ) : null}

      {/* The runtime driver — honest about availability and every blocked state. */}
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-canvas p-3">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">
            {t('courier.runner.heading', 'Run the courier')}
          </span>
          <RunStatusBadge phase={phase} t={t} />
        </span>

        {!nativeAvailable ? (
          <p className="text-sm text-ink-muted">
            {t(
              'courier.runner.needsApp',
              'The courier moves content over your device’s radios, which need the installed Licio app. In a browser you can still import and export offline bundles as files.',
            )}
          </p>
        ) : forcedOff ? (
          <p className="text-sm text-ink-muted">
            {t(
              'courier.runner.modeOff',
              'The current connection mode keeps every radio off. Change the mode to use the courier.',
            )}
          </p>
        ) : (
          <p className="text-sm text-ink-muted">
            {t(
              'courier.runner.intro',
              'When running, this device exchanges public content with nearby couriers over the radios you enabled. Everything received is re-checked against its content signatures before it is shown.',
            )}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {running ? (
            <Button variant="secondary" size="md" onClick={() => void stop()}>
              {t('courier.runner.stop', 'Stop courier')}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="md"
              loading={phase.kind === 'starting'}
              disabled={!canStart || !nativeAvailable}
              onClick={() => void start()}
            >
              {t('courier.runner.start', 'Start courier')}
            </Button>
          )}
        </div>

        {phase.kind === 'running' ? (
          <p className="text-xs text-ink-muted" role="status">
            {t('courier.runner.runningOn', 'Running on: {channels}', {
              channels: phase.channels.map((c) => channelLabel(c, t)).join(', '),
            })}
          </p>
        ) : null}

        {phase.kind === 'blocked' ? (
          <p className="text-sm text-warning-on-soft" role="status">
            {blockedMessage(phase.reason, t)}
          </p>
        ) : null}
        {phase.kind === 'unavailable' && nativeAvailable ? (
          <p className="text-sm text-ink-muted" role="status">
            {t(
              'courier.runner.noRadio',
              'None of the radios you enabled are available on this device.',
            )}
          </p>
        ) : null}
        {phase.kind === 'error' ? (
          <p className="text-sm text-error-on-soft" role="alert">
            {t('courier.runner.error', 'The courier could not start. Please try again.')}
          </p>
        ) : null}

        {/* The honest per-exchange activity log — never a "delivered"/"secure" claim. */}
        {activity.length > 0 ? (
          <ul
            className="flex flex-col gap-1"
            aria-label={t('courier.runner.activity', 'Courier activity')}
          >
            {activity.map((entry) => (
              <li key={entry.id} className="text-xs text-ink-muted">
                {entry.carried
                  ? t(
                      'courier.runner.exchanged',
                      'Exchanged with a nearby device over {channel}.',
                      {
                        channel: channelLabel(entry.channel, t),
                      },
                    )
                  : t(
                      'courier.runner.skipped',
                      'A nearby device over {channel} was not exchanged with ({reason}).',
                      {
                        channel: channelLabel(entry.channel, t),
                        reason: entry.skippedReason || 'no result',
                      },
                    )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function RunStatusBadge({
  phase,
  t,
}: {
  phase: RunPhase;
  t: ReturnType<typeof useT>;
}): React.ReactElement {
  switch (phase.kind) {
    case 'running':
      return <Badge tone="success">{t('courier.runner.status.running', 'Running')}</Badge>;
    case 'starting':
      return <Badge tone="info">{t('courier.runner.status.starting', 'Starting…')}</Badge>;
    case 'blocked':
      return <Badge tone="warning">{t('courier.runner.status.blocked', 'Not started')}</Badge>;
    case 'unavailable':
      return <Badge tone="neutral">{t('courier.runner.status.unavailable', 'Unavailable')}</Badge>;
    case 'error':
      return <Badge tone="error">{t('courier.runner.status.error', 'Error')}</Badge>;
    default:
      return <Badge tone="neutral">{t('courier.runner.status.idle', 'Off')}</Badge>;
  }
}

function blockedMessage(reason: CourierBlockedReason, t: ReturnType<typeof useT>): string {
  switch (reason) {
    case 'forced_off_in_mode':
      return t('courier.runner.blocked.mode', 'The current connection mode keeps the radios off.');
    case 'below_battery_floor':
      return t(
        'courier.runner.blocked.battery',
        'The battery is below your courier floor and the device is not charging.',
      );
    case 'no_peers':
      return t(
        'courier.runner.blocked.noPeers',
        'You chose to exchange with no one, so the radios stay idle.',
      );
    case 'radio_unavailable':
      return t(
        'courier.runner.blocked.radioUnavailable',
        'A radio could not start (permission denied or unavailable). The courier is stopped; sync still uses the network when online.',
      );
    case 'disabled':
    case '':
      return t('courier.runner.blocked.disabled', 'No radio is enabled.');
  }
}

function channelLabel(channel: CourierChannel, t: ReturnType<typeof useT>): string {
  switch (channel) {
    case 'nearby':
      return t('courier.channel.nearby', 'Nearby Connections');
    case 'wifiDirect':
      return t('courier.channel.wifiDirect', 'Wi-Fi Direct');
    case 'bluetooth':
      return t('courier.channel.bluetooth', 'Bluetooth');
    case 'usb':
      return t('courier.channel.usb', 'USB');
  }
}
