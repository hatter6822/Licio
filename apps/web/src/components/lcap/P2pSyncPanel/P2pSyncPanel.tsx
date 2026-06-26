// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.6 — the live LCAP P2P sync UI: the runtime caller `syncRoomOverP2p` previously
// lacked.  It lets a user run ONE §16 exchange for a PUBLIC room directly with another
// device over a WebRTC data channel (the server-blind signaling rendezvous), falling back
// to the always-correct HTTPS anchor when the peer is unreachable.  This realizes the live
// WebRTC LCAP carrier as a real, user-driven flow instead of a test-only consumer.
//
// HONEST STATE throughout — never a fabricated "connected"/"secure"/"delivered":
//   * WebRTC is OFF by default; pressing "Sync over a direct connection" is the explicit
//     opt-in (the §26.4 decision then runs in `standard` privacy mode, peer-IP-aware).
//   * The result names WHICH transport actually carried the exchange — `webrtc` only when
//     the live peer answered, `https` when it fell back to the server anchor — so the UI
//     never claims a peer link that did not happen.
//   * The bytes confer NO trust from the channel: the peer's response is re-validated
//     downstream against its CIDs/COSE signatures (§18.4); this panel reports only that an
//     exchange round-tripped, never that content was "verified".
//
// PEER DISCOVERY RESIDUAL (honest limit): the public LCAP plane has no peer-rendezvous /
// presence service yet, so the two opaque peer keys are entered by hand (a peer shares its
// key out of band, like a meeting code).  Automatic public-peer discovery is a tracked
// WS-R residual (docs/lcap/README.md); until it lands this is a manual, code-share flow.
//
// `syncRoomOverP2p` (and through it `@licio/lcap-p2p`) loads via a DYNAMIC import only, so
// the WebRTC/codec core stays off the initial bundle (`check:lcap-p2p-split`).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../ui/Button/index.js';
import { Input } from '../../ui/Input/index.js';

/** The honest runtime phases the panel surfaces. */
type SyncPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'synced'; readonly transport: string }
  | { readonly kind: 'no_result' }
  | { readonly kind: 'error'; readonly reason: string };

/** Parse a hex string (32-byte room rendezvous hash) to bytes, or `null` if malformed. */
function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface P2pSyncPanelProps {
  /** A pre-filled room rendezvous hash (hex), when the panel is opened in a room context. */
  readonly roomHash?: string;
  /** A human label for the room (shown in the heading). */
  readonly roomLabel?: string;
  readonly className?: string;
}

/**
 * The live LCAP P2P sync control.  Collects the public room hash + the two opaque peer keys
 * + the role, then runs ONE `syncRoomOverP2p` exchange (WebRTC-preferred, HTTPS-anchor
 * fallback) and reports the honest outcome.
 */
export function P2pSyncPanel({
  roomHash: initialRoomHash,
  roomLabel,
  className,
}: P2pSyncPanelProps): React.ReactElement {
  const t = useT();
  const [roomHash, setRoomHash] = useState(initialRoomHash ?? '');
  const [selfPeerKey, setSelfPeerKey] = useState('');
  const [remotePeerKey, setRemotePeerKey] = useState('');
  const [initiator, setInitiator] = useState(true);
  const [phase, setPhase] = useState<SyncPhase>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const roomBytes = hexToBytes(roomHash);
  const canSync =
    roomBytes !== null &&
    roomBytes.length === 32 &&
    selfPeerKey.trim().length > 0 &&
    remotePeerKey.trim().length > 0 &&
    phase.kind !== 'connecting';

  const runSync = useCallback(async () => {
    const bytes = hexToBytes(roomHash);
    if (bytes?.length !== 32) {
      setPhase({ kind: 'error', reason: t('lcap.p2pSync.badRoom', 'invalid room hash') });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: 'connecting' });
    try {
      // Dynamic imports: the WebRTC carrier (`@licio/lcap-p2p`) + the `@licio/lcap` codec
      // stay off the initial bundle.  Pressing Sync is the explicit WebRTC opt-in.
      const [{ syncRoomOverP2p }, { getLcapDb }] = await Promise.all([
        import('../../../lcap/transports/sync-over-p2p.js'),
        import('../../../lcap/db.js'),
      ]);
      const db = await getLcapDb();
      const result = await syncRoomOverP2p({
        db,
        roomIdHash: bytes,
        selfPeerKey: selfPeerKey.trim(),
        remotePeerKey: remotePeerKey.trim(),
        initiator,
        // Scope sharing to THIS room only — a targeted room sync never gossips unrelated rooms'
        // content to the manually-entered peer (the responder/push filter by `roomHashAllowlist`).
        scope: { roomHashAllowlist: [roomHash.trim()] },
        // The user pressed Sync — opt WebRTC in explicitly (off by default otherwise).
        privacy: { mode: 'standard', userEnabled: true },
        signal: controller.signal,
        timeoutMs: 25_000,
      });
      if (!result) {
        setPhase({ kind: 'no_result' });
        return;
      }
      setPhase({ kind: 'synced', transport: result.transport });
    } catch {
      setPhase({ kind: 'error', reason: t('lcap.p2pSync.failed', 'the sync could not complete') });
    } finally {
      abortRef.current = null;
    }
  }, [roomHash, selfPeerKey, remotePeerKey, initiator, t]);

  // Abort an in-flight sync if the panel UNMOUNTS — else the request + any push_pack could still be
  // transmitted (WebRTC, or the HTTPS fallback) after the UI owner is gone (#G).
  useEffect(() => () => abortRef.current?.abort(), []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase({ kind: 'idle' });
  }, []);

  return (
    <section
      className={cn('flex flex-col gap-4 rounded-lg bg-surface-sunken p-4', className)}
      aria-labelledby="lcap-p2p-sync-heading"
    >
      <h3 id="lcap-p2p-sync-heading" className="text-base font-semibold text-ink">
        {t('lcap.p2pSync.heading', 'Sync this room over a direct connection')}
        {roomLabel ? <span className="text-ink-muted"> — {roomLabel}</span> : null}
      </h3>
      <p className="text-sm text-ink-muted">
        {t(
          'lcap.p2pSync.intro',
          'Exchange a public room directly with another device over a peer-to-peer connection — useful when the server is slow or unreachable. If the peer cannot be reached, it falls back to the Licio server. Everything received is re-checked against its content signatures before it is shown.',
        )}
      </p>

      <Input
        label={t('lcap.p2pSync.roomHash', 'Public room hash (hex)')}
        value={roomHash}
        onChange={(e) => setRoomHash(e.target.value)}
        placeholder="a1b2c3…"
        autoComplete="off"
      />
      <Input
        label={t('lcap.p2pSync.selfKey', 'Your peer code')}
        value={selfPeerKey}
        onChange={(e) => setSelfPeerKey(e.target.value)}
        autoComplete="off"
      />
      <Input
        label={t('lcap.p2pSync.remoteKey', 'Their peer code')}
        value={remotePeerKey}
        onChange={(e) => setRemotePeerKey(e.target.value)}
        autoComplete="off"
      />

      {/* The role: one device offers, the other answers. */}
      <div
        role="radiogroup"
        aria-label={t('lcap.p2pSync.roleLabel', 'Connection role')}
        className="flex gap-4"
      >
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="radio"
            name="lcap-p2p-role"
            checked={initiator}
            onChange={() => setInitiator(true)}
          />
          {t('lcap.p2pSync.roleStart', 'Start the connection')}
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="radio"
            name="lcap-p2p-role"
            checked={!initiator}
            onChange={() => setInitiator(false)}
          />
          {t('lcap.p2pSync.roleAnswer', 'Answer the connection')}
        </label>
      </div>

      <p className="text-xs text-ink-muted">
        {t(
          'lcap.p2pSync.discoveryNote',
          'Licio cannot yet find public peers for you automatically, so you and the other device share peer codes out of band (like a meeting code). This is a manual flow for now.',
        )}
      </p>

      <div className="flex flex-wrap gap-2">
        {phase.kind === 'connecting' ? (
          <Button variant="secondary" size="md" onClick={cancel}>
            {t('lcap.p2pSync.cancel', 'Cancel')}
          </Button>
        ) : (
          <Button variant="primary" size="md" disabled={!canSync} onClick={() => void runSync()}>
            {t('lcap.p2pSync.start', 'Sync over a direct connection')}
          </Button>
        )}
      </div>

      {/* Honest result — names the transport that actually carried it. */}
      {phase.kind === 'connecting' ? (
        <p className="text-sm text-ink-muted" role="status">
          {t('lcap.p2pSync.connecting', 'Trying a direct connection… this may take a moment.')}
        </p>
      ) : null}
      {phase.kind === 'synced' ? (
        <p className="text-sm text-success-on-soft" role="status">
          {phase.transport === 'webrtc'
            ? t(
                'lcap.p2pSync.syncedPeer',
                'Synced directly with the other device. Anything new is checked against its signatures before it appears.',
              )
            : t(
                'lcap.p2pSync.syncedAnchor',
                'The direct connection was not reachable, so this synced through the Licio server instead.',
              )}
        </p>
      ) : null}
      {phase.kind === 'no_result' ? (
        <p className="text-sm text-warning-on-soft" role="status">
          {t(
            'lcap.p2pSync.noResult',
            'Could not reach the other device or the server. Nothing was exchanged; you can try again.',
          )}
        </p>
      ) : null}
      {phase.kind === 'error' ? (
        <p className="text-sm text-error-on-soft" role="alert">
          {t('lcap.p2pSync.error', 'The sync could not complete ({reason}).', {
            reason: phase.reason,
          })}
        </p>
      ) : null}
    </section>
  );
}
