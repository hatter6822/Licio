// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.2 — the §22.6 transport-status surface.  Shows the configured LCAP transports
// and their capabilities (server-mediated / carries-private / latency class) plus the
// current operational mode's discovery posture, so a user understands HOW content moves
// and what each carrier can carry.  The HTTPS anchor is shown as the always-present,
// non-removable trust anchor — there is NO control to remove it (every fallback chain
// ends with it, so correctness never depends on an optional transport).
//
// It reads the content-free `TRANSPORT_CATALOG` mirror + `discoveryAllowed`, both kept
// off the lazy `@licio/lcap` codec chunk; this is an always-available surface.

import { useT } from '../../../i18n/index.js';
import { discoveryAllowed, type OperationalMode } from '../../../lcap/operational-modes.js';
import {
  type LcapLatencyClass,
  TRANSPORT_CATALOG,
  type TransportSummary,
} from '../../../lcap/transport-catalog.js';
import { cn } from '../../../lib/cn.js';
import { Badge } from '../../ui/Badge/index.js';

const TRANSPORT_NAME: Readonly<Record<TransportSummary['id'], { key: string; text: string }>> = {
  https: { key: 'lcap.transport.https', text: 'Licio server (HTTPS)' },
  webtransport: { key: 'lcap.transport.webtransport', text: 'Licio server (WebTransport)' },
  webrtc: { key: 'lcap.transport.webrtc', text: 'Direct peer (WebRTC)' },
  courier: { key: 'lcap.transport.courier', text: 'Courier ferry (file / nearby)' },
  qr: { key: 'lcap.transport.qr', text: 'QR micro-bundle' },
};

const LATENCY_LABEL: Readonly<Record<LcapLatencyClass, { key: string; text: string }>> = {
  low: { key: 'lcap.transport.latency.low', text: 'Low latency' },
  medium: { key: 'lcap.transport.latency.medium', text: 'Medium latency' },
  high: { key: 'lcap.transport.latency.high', text: 'Slow / manual' },
};

export interface TransportStatusProps {
  /** The current operational mode (drives the discovery-posture line). */
  readonly mode: OperationalMode;
  readonly className?: string;
}

export function TransportStatus({ mode, className }: TransportStatusProps): React.ReactElement {
  const t = useT();
  const discovery = discoveryAllowed(mode);
  return (
    <div
      role="group"
      className={cn('flex flex-col gap-3', className)}
      aria-label={t('lcap.transport.label', 'Transports')}
    >
      <p className="text-sm text-ink-muted">
        {discovery
          ? t(
              'lcap.transport.discoveryOn',
              'Automatic peer discovery is ON in this mode. Optional carriers may be tried, then the Licio server.',
            )
          : t(
              'lcap.transport.discoveryOff',
              'Automatic peer discovery is OFF in this mode. Content moves only when you act, ending with the Licio server.',
            )}
      </p>
      <ul className="flex flex-col gap-2">
        {TRANSPORT_CATALOG.map((transport) => (
          <li
            key={transport.id}
            className="flex flex-col gap-1 rounded-lg border border-line bg-canvas p-3"
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">
                {t(TRANSPORT_NAME[transport.id].key, TRANSPORT_NAME[transport.id].text)}
              </span>
              {transport.anchor ? (
                <Badge tone="info">{t('lcap.transport.anchor', 'Always on (trust anchor)')}</Badge>
              ) : (
                <Badge tone="neutral">{t('lcap.transport.optional', 'Optional')}</Badge>
              )}
            </span>
            <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
              <span>
                {transport.serverMediated
                  ? t('lcap.transport.serverMediated', 'Routes via the Licio server')
                  : t('lcap.transport.peerToPeer', 'Direct peer-to-peer')}
              </span>
              <span>
                {transport.carriesPrivate
                  ? t('lcap.transport.carriesPrivate', 'Can carry private content')
                  : t('lcap.transport.publicOnly', 'Public content only')}
              </span>
              <span>
                {t(
                  LATENCY_LABEL[transport.latencyClass].key,
                  LATENCY_LABEL[transport.latencyClass].text,
                )}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
