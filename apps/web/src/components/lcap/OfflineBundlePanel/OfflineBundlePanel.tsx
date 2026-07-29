// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.1a/b + WS-R.16.1 — the offline `.licio-bundle` export/import surface.
// Orchestrates the tested client-local flows (`bundle-export` / `bundle-import`) so a
// user can hand a room's content to a peer on a USB stick / file share with no
// connectivity, and import a bundle a peer handed them — running the REAL @licio/lcap
// pack codec in the browser (loaded as a lazy chunk).  The surface is honest about
// trust and disclosure:
//   - EXPORT shows the §26.2 disclosure (which rooms, media, size, "recipients may
//     copy onward") BEFORE producing any file;
//   - IMPORT shows the pre-render summary (counts, lanes, rooms, integrity) BEFORE
//     committing, then reports the per-object outcome — quarantining missing-dependency
//     records — and never implies a trust the projection has not granted (§34, §8.3).
//
// WS-R.16.1 cross-plane bridge — this is the REAL runtime caller for a WS-S private
// room's ciphertext riding an LCAP bundle:
//   - PRIVATE EXPORT: read a private room's opaque envelopes (the engine's storage port)
//     and emit a `contains_private_encrypted` `.licio-bundle` carrying ONLY ciphertext +
//     opaque §28.2 hints — the LCAP layer never decrypts;
//   - PRIVATE IMPORT: a `.licio-bundle` whose privacy label is `contains_private_encrypted`
//     is REFUSED by the public store path and ROUTED to the cross-plane bridge → the
//     device-local private engine (`PrivateRoomSession.ingest`), which performs the REAL
//     trust projection (signature + AEAD).  The bridge + private engine load lazily, so
//     the crypto/protocol cores never enter the initial bundle (check:private-p2p-split).

import type { ExportDisclosure, ParsedPack } from '@licio/lcap';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import {
  buildBundle,
  bundleFilename,
  downloadBundle,
  prepareRoomExport,
  type RoomExport,
} from '../../../lcap/bundle-export.js';
import {
  type BundleSummary,
  type CommitCounts,
  commitImportedBundle,
  heldCidsFor,
  importBundleObjects,
  readBundleForImport,
} from '../../../lcap/bundle-import.js';
import { getLcapDb } from '../../../lcap/db.js';
import { getOperationalMode } from '../../../lcap/mode-state.js';
import { exportPostureForMode, mediaPrefetchAllowed } from '../../../lcap/operational-modes.js';
import { type LocalRoom, listLocalRooms } from '../../../lcap/store.js';
import { cn } from '../../../lib/cn.js';
import { Badge } from '../../ui/Badge/index.js';
import { Button } from '../../ui/Button/index.js';
import { QuarantineNotice } from '../OfflineStates/index.js';
import { TrustBadge } from '../TrustBadge/index.js';

/** A device-local private room the panel can export, by id + display name. */
interface PrivateRoomChoice {
  readonly roomId: string;
  readonly name: string;
}

/**
 * The shape of one recovered + ingested private import (mirrored locally so this module
 * never statically imports `@licio/private-p2p`).  `recovered` is what the bridge pulled
 * from the bundle; `accepted`/`quarantined` is what the private engine's trust projection
 * granted — an honest, never-overclaimed count.
 */
interface PrivateImportCounts {
  readonly recovered: number;
  readonly rejected: number;
  readonly accepted: number;
  readonly quarantined: number;
  /** Opened and already held — an exact re-receive of a backup this room has. */
  readonly duplicate: number;
  /** Retained awaiting an epoch key or device cert: NOT in room state yet. */
  readonly pending: number;
}

/**
 * Read a private room's opaque ciphertext envelopes from the device-local engine storage
 * and emit a `contains_private_encrypted` bundle.  Loaded lazily (the bridge + the
 * private storage adapter pull the crypto/protocol core off the synchronous path).
 */
async function buildPrivateRoomBundle(roomId: string): Promise<Uint8Array> {
  const [{ exportPrivateEnvelopesToBundle }, { IndexedDbPrivateRoomStorage }] = await Promise.all([
    import('../../../lcap/cross-plane-bridge.js'),
    import('../../../private-p2p/storage.js'),
  ]);
  const stored = await new IndexedDbPrivateRoomStorage(roomId).listEnvelopes();
  const { bundleBytes } = await exportPrivateEnvelopesToBundle(stored.map((s) => s.envelope));
  return bundleBytes;
}

/**
 * Route a `contains_private_encrypted` bundle into the device-local private engine: the
 * cross-plane bridge recovers the opaque envelopes (CID + §28.2-descriptor verified,
 * never decrypted), then `PrivateRoomSession.ingest` performs the REAL trust projection
 * (signature + AEAD), accepting what belongs to `roomId` and quarantining the rest.
 */
async function ingestPrivateBundle(
  bytes: Uint8Array,
  roomId: string,
): Promise<PrivateImportCounts> {
  const [{ importBundleToPrivateEnvelopes }, { PrivateRoomSession }] = await Promise.all([
    import('../../../lcap/cross-plane-bridge.js'),
    import('../../../private-p2p/room-manager.js'),
  ]);
  const recovered = await importBundleToPrivateEnvelopes(bytes);
  const session = await PrivateRoomSession.load(roomId);
  if (!session) throw new Error('private_room_not_found');
  const report = await session.ingest(recovered.envelopes.map((r) => r.envelope));
  return {
    recovered: recovered.envelopes.length,
    rejected: recovered.rejected.length,
    accepted: report.accepted.length,
    quarantined: report.quarantined.length,
    duplicate: report.duplicate,
    pending: report.pending,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ExportState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'preparing' }
  | {
      readonly phase: 'ready';
      readonly data: RoomExport & { disclosure: ExportDisclosure };
      // The room this bundle was prepared for, so the download's filename matches its CONTENTS even if
      // the picker moved on while preparing (#AM).
      readonly roomHash: string;
    }
  | { readonly phase: 'done'; readonly filename: string }
  | { readonly phase: 'error'; readonly message: string };

type ImportState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'reading' }
  | { readonly phase: 'summarized'; readonly pack: ParsedPack; readonly summary: BundleSummary }
  | { readonly phase: 'committing' }
  | { readonly phase: 'done'; readonly counts: CommitCounts }
  // A `contains_private_encrypted` bundle: the public store path refused it; offer to
  // route it into a chosen device-local private room via the cross-plane bridge.
  | { readonly phase: 'private_routed'; readonly bytes: Uint8Array }
  | { readonly phase: 'private_committing' }
  | { readonly phase: 'private_done'; readonly counts: PrivateImportCounts }
  | { readonly phase: 'rejected'; readonly status: string };

// A private EXPORT (WS-R.16.1): pick a device-local private room, produce + download a
// `contains_private_encrypted` bundle carrying only ciphertext + opaque §28.2 hints.
type PrivateExportState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'building' }
  | { readonly phase: 'done'; readonly filename: string }
  | { readonly phase: 'error' };

export interface OfflineBundlePanelProps {
  /** The room to export (the export section is shown only when a room is in context). */
  readonly roomHash?: string;
  /** A human label for the room, shown in the export heading. */
  readonly roomLabel?: string;
  /**
   * High-risk posture (stealth/emergency): generic export filename + confirm-before-
   * export (§26.3).  When omitted it is DERIVED from the current §33 operational mode
   * (`exportPostureForMode`), so the Stealth/Emergency control actually changes the
   * export surface here — not a cosmetic flag.
   */
  readonly highRisk?: boolean;
  /**
   * Offer the WS-R.16.1 private-room cross-plane bundle bridge: when `true` (the
   * default), the panel discovers the device's WS-S private rooms so a user can export
   * one as a `.licio-bundle` and route a private bundle a peer handed them into a chosen
   * private room.  Set `false` to hide the private surface (e.g. a public-only context).
   */
  readonly enablePrivateRooms?: boolean;
  readonly className?: string;
}

export function OfflineBundlePanel({
  roomHash,
  roomLabel,
  highRisk,
  enablePrivateRooms = true,
  className,
}: OfflineBundlePanelProps): React.ReactElement {
  const t = useT();
  const [exportState, setExportState] = useState<ExportState>({ phase: 'idle' });
  const [importState, setImportState] = useState<ImportState>({ phase: 'idle' });
  const [privateRooms, setPrivateRooms] = useState<readonly PrivateRoomChoice[]>([]);
  const [privateExport, setPrivateExport] = useState<PrivateExportState>({ phase: 'idle' });
  // The private room a recovered private bundle is routed into (chosen by the user).
  const [privateTargetRoomId, setPrivateTargetRoomId] = useState<string>('');
  // The PUBLIC rooms held offline (discovered from lcap_v2) + the one the user picked to export —
  // so the export is reachable from the offline page (no room-context prop needed).
  const [localRooms, setLocalRooms] = useState<readonly LocalRoom[]>([]);
  const [pickedRoom, setPickedRoom] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The engine now REPORTS what it did with everything it opened, so the panel
  // no longer subtracts one count from another to guess.  The derived
  // remainder (`recovered - accepted - quarantined`) counted a PENDING envelope
  // — one retained because its epoch key or device cert has not arrived — as
  // "already in this room", so a backup none of whose ops had entered room
  // state was reported as an idempotent success.  Those are opposite answers.
  const alreadyPresent = importState.phase === 'private_done' ? importState.counts.duplicate : 0;
  const awaitingKeys = importState.phase === 'private_done' ? importState.counts.pending : 0;
  // The room being exported: the explicit prop (mounted FROM a room) overrides the offline-page pick.
  const effectiveRoomHash = roomHash ?? (pickedRoom || undefined);

  // Discover the device's WS-S private rooms (lazily; the room manager pulls the
  // private-p2p core off the synchronous path).  A failure leaves the list empty, so the
  // private surfaces simply do not appear — never a crash.
  useEffect(() => {
    if (!enablePrivateRooms) return;
    let active = true;
    void (async () => {
      try {
        const { PrivateRoomSession } = await import('../../../private-p2p/room-manager.js');
        const rooms = await PrivateRoomSession.list();
        if (active) setPrivateRooms(rooms.map((r) => ({ roomId: r.roomId, name: r.name })));
      } catch {
        if (active) setPrivateRooms([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [enablePrivateRooms]);

  // Discover the PUBLIC rooms held offline so the offline page can offer them for export (only when
  // no room was passed in context).  A failure leaves the list empty — the picker simply hides.
  useEffect(() => {
    if (roomHash !== undefined) return; // an explicit room context — no picker needed
    let active = true;
    void (async () => {
      try {
        const db = await getLcapDb();
        const rooms = await listLocalRooms(db);
        if (active) setLocalRooms(rooms);
      } catch {
        if (active) setLocalRooms([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [roomHash]);

  // The §26 export posture: the explicit prop overrides; otherwise the current §33 mode
  // decides (Stealth/Emergency → generic filename + confirm).  Read once per render from
  // the persisted mode (a non-reactive module, like the sync gate reads it).
  const mode = getOperationalMode();
  const posture = exportPostureForMode(mode);
  const effectiveHighRisk = highRisk ?? posture.highRisk;
  const mediaPrefetch = mediaPrefetchAllowed(mode);

  // Track the LATEST requested room so a slow prepare for a now-abandoned room can be ignored (#AM).
  const latestRoomRef = useRef<string | undefined>(effectiveRoomHash);
  useEffect(() => {
    latestRoomRef.current = effectiveRoomHash;
  }, [effectiveRoomHash]);

  const prepareExport = useCallback(async () => {
    const preparingRoom = effectiveRoomHash;
    if (!preparingRoom) return;
    setExportState({ phase: 'preparing' });
    try {
      const data = await prepareRoomExport(preparingRoom);
      if (latestRoomRef.current !== preparingRoom) return; // picker moved on mid-prepare — drop stale (#AM)
      setExportState({ phase: 'ready', data, roomHash: preparingRoom });
    } catch {
      if (latestRoomRef.current !== preparingRoom) return;
      setExportState({
        phase: 'error',
        message: t('lcap.bundle.exportError', 'Could not prepare the export.'),
      });
    }
  }, [effectiveRoomHash, t]);

  const doExport = useCallback(async () => {
    if (exportState.phase !== 'ready') return;
    try {
      const bytes = await buildBundle({
        objects: exportState.data.objects,
        disclosure: exportState.data.disclosure,
      });
      // Name the file for the room the bundle was PREPARED for (its actual contents), never the
      // possibly-changed current selection (#AM).
      const filename = await bundleFilename({
        highRisk: effectiveHighRisk,
        roomHash: exportState.roomHash,
      });
      await downloadBundle(bytes, filename);
      setExportState({ phase: 'done', filename });
    } catch {
      setExportState({
        phase: 'error',
        message: t('lcap.bundle.exportError', 'Could not prepare the export.'),
      });
    }
  }, [exportState, effectiveHighRisk, t]);

  // Picking a different room resets any prepared/finished export so it can't apply to the wrong room.
  const pickRoom = useCallback((next: string) => {
    setPickedRoom(next);
    setExportState({ phase: 'idle' });
  }, []);

  const onFileChosen = useCallback(
    async (file: File) => {
      setImportState({ phase: 'reading' });
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const outcome = await readBundleForImport(bytes);
        if (!outcome.ok) {
          // §8 / §28 fail-closed routing: a private-encrypted bundle is refused by the
          // public store path.  If the device has private rooms, route it to the
          // cross-plane bridge → a chosen private engine; otherwise surface the status.
          if (
            outcome.status === 'private_bundle' &&
            enablePrivateRooms &&
            privateRooms.length > 0
          ) {
            setPrivateTargetRoomId((current) => current || (privateRooms[0]?.roomId ?? ''));
            setImportState({ phase: 'private_routed', bytes });
            return;
          }
          setImportState({ phase: 'rejected', status: outcome.status });
          return;
        }
        setImportState({ phase: 'summarized', pack: outcome.pack, summary: outcome.summary });
      } catch {
        setImportState({ phase: 'rejected', status: 'unreadable' });
      }
    },
    [enablePrivateRooms, privateRooms],
  );

  const doImport = useCallback(async () => {
    if (importState.phase !== 'summarized') return;
    setImportState({ phase: 'committing' });
    try {
      const db = await getLcapDb();
      // Objects we already hold are reported `already_have` and skipped on commit, so a
      // re-import never overwrites a record held at higher trust back to integrity-only.
      const alreadyHave = await heldCidsFor(db, importState.pack);
      const result = await importBundleObjects(importState.pack, { alreadyHave });
      const counts = await commitImportedBundle(db, importState.pack, result);
      setImportState({ phase: 'done', counts });
    } catch {
      setImportState({ phase: 'rejected', status: 'commit_failed' });
    }
  }, [importState]);

  // WS-R.16.1 — route the recovered private bundle into the chosen device-local private
  // engine (the cross-plane bridge → `PrivateRoomSession.ingest`, which re-verifies every
  // envelope: signature + AEAD).  The honest count separates what was recovered (opaque)
  // from what the trust projection ACCEPTED — never an overclaim.
  const doPrivateImport = useCallback(async () => {
    if (importState.phase !== 'private_routed' || !privateTargetRoomId) return;
    const { bytes } = importState;
    setImportState({ phase: 'private_committing' });
    try {
      const counts = await ingestPrivateBundle(bytes, privateTargetRoomId);
      setImportState({ phase: 'private_done', counts });
    } catch {
      setImportState({ phase: 'rejected', status: 'private_ingest_failed' });
    }
  }, [importState, privateTargetRoomId]);

  // WS-R.16.1 — export a device-local private room as a `contains_private_encrypted`
  // `.licio-bundle` carrying only ciphertext + opaque §28.2 hints (the LCAP layer never
  // decrypts).  Uses the §26.3 generic high-risk filename so the file reveals no room.
  const doPrivateExport = useCallback(async (roomId: string) => {
    setPrivateExport({ phase: 'building' });
    try {
      const bytes = await buildPrivateRoomBundle(roomId);
      // A private bundle ALWAYS uses the room/topic-free generic name (§26.3): the
      // file's existence already reveals "a private room"; the name reveals nothing more.
      const filename = await bundleFilename({ highRisk: true });
      await downloadBundle(bytes, filename);
      setPrivateExport({ phase: 'done', filename });
    } catch {
      setPrivateExport({ phase: 'error' });
    }
  }, []);

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      {/* Offline-page room PICKER: when no room was passed in context, let the user choose one of the
          rooms they hold offline to export (identified by its canonical hash — there is no name store). */}
      {roomHash === undefined && localRooms.length > 0 ? (
        <section
          className="flex flex-col gap-2 rounded-lg bg-surface-sunken p-4"
          aria-labelledby="lcap-room-picker-heading"
        >
          <h3 id="lcap-room-picker-heading" className="text-base font-semibold text-ink">
            {t('lcap.bundle.pickRoomHeading', 'Choose a room to export')}
          </h3>
          <div
            role="radiogroup"
            aria-labelledby="lcap-room-picker-heading"
            className="flex flex-col gap-1"
          >
            {localRooms.map((room) => (
              <label key={room.roomHash} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name="lcap-export-room"
                  checked={pickedRoom === room.roomHash}
                  onChange={() => pickRoom(room.roomHash)}
                />
                <span className="font-mono">{room.roomHash.slice(0, 8)}…</span>
                <span className="text-ink-muted">
                  {t('lcap.bundle.roomItemCount', '({count} items)', { count: room.recordCount })}
                </span>
              </label>
            ))}
          </div>
        </section>
      ) : null}

      {effectiveRoomHash ? (
        <section
          className="flex flex-col gap-3 rounded-lg bg-surface-sunken p-4"
          aria-labelledby="lcap-export-heading"
        >
          <h3 id="lcap-export-heading" className="text-base font-semibold text-ink">
            {t('lcap.bundle.exportHeading', 'Export this room for offline sharing')}
            {roomLabel ? <span className="text-ink-muted"> — {roomLabel}</span> : null}
          </h3>
          <p className="text-sm text-ink-muted">
            {t(
              'lcap.bundle.exportIntro',
              'Save this room’s content as a file you can hand to someone with no connection. They can read it offline — and may pass it on.',
            )}
          </p>

          {exportState.phase === 'idle' || exportState.phase === 'preparing' ? (
            <div>
              <Button
                variant="secondary"
                size="md"
                loading={exportState.phase === 'preparing'}
                onClick={prepareExport}
              >
                {t('lcap.bundle.prepareExport', 'Prepare export')}
              </Button>
            </div>
          ) : null}

          {exportState.phase === 'ready' ? (
            <div className="flex flex-col gap-2 rounded-md bg-warning-soft p-3 text-warning-on-soft">
              <Badge tone="warning">
                {t('lcap.bundle.disclosureHeading', 'Before you export')}
              </Badge>
              <ul className="list-disc pl-5 text-sm">
                <li>
                  {t(
                    'lcap.bundle.disclosureCounts',
                    '{records} posts, {proofs} proofs, {blocks} media — about {size}',
                    {
                      records: exportState.data.recordCount,
                      proofs: exportState.data.proofCount,
                      blocks: exportState.data.blockCount,
                      size: formatBytes(exportState.data.disclosure.approxSizeBytes),
                    },
                  )}
                </li>
                <li>
                  {t('lcap.bundle.disclosureRooms', 'Reveals membership of {count} room(s)', {
                    count: exportState.data.disclosure.roomCount,
                  })}
                </li>
                <li>
                  {t(
                    'lcap.bundle.disclosureForward',
                    'Anyone you share it with can read it — and pass it on.',
                  )}
                </li>
                {exportState.data.disclosure.carriesIdentities ? (
                  <li>
                    {t(
                      'lcap.bundle.disclosureIdentities',
                      'Includes device/identity material (certificates or capabilities) that reveals account and device identifiers.',
                    )}
                  </li>
                ) : null}
                {/* §33 mode-derived posture: honest about how this mode shapes the export. */}
                {effectiveHighRisk ? (
                  <li>
                    {t(
                      'lcap.bundle.disclosureHighRisk',
                      'High-risk mode: the file uses a generic name (no room or topic) so it does not reveal its contents at rest.',
                    )}
                  </li>
                ) : null}
                {!mediaPrefetch && exportState.data.blockCount > 0 ? (
                  <li>
                    {t(
                      'lcap.bundle.disclosureMediaOff',
                      'This mode does not prefetch media, so some media this room references may not be included.',
                    )}
                  </li>
                ) : null}
              </ul>
              <div className="flex gap-2">
                <Button variant="primary" size="md" onClick={doExport}>
                  {t('lcap.bundle.exportFile', 'Export file')}
                </Button>
                <Button variant="ghost" size="md" onClick={() => setExportState({ phase: 'idle' })}>
                  {t('lcap.common.cancel', 'Cancel')}
                </Button>
              </div>
            </div>
          ) : null}

          {exportState.phase === 'done' ? (
            <p className="text-sm text-success-on-soft" role="status">
              {t('lcap.bundle.exportDone', 'Saved {filename}.', { filename: exportState.filename })}
            </p>
          ) : null}
          {exportState.phase === 'error' ? (
            <p className="text-sm text-error-on-soft" role="alert">
              {exportState.message}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* WS-R.16.1 — export a device-local PRIVATE room as an opaque-ciphertext bundle. */}
      {enablePrivateRooms && privateRooms.length > 0 ? (
        <section
          className="flex flex-col gap-3 rounded-lg bg-surface-sunken p-4"
          aria-labelledby="lcap-private-export-heading"
        >
          <h3 id="lcap-private-export-heading" className="text-base font-semibold text-ink">
            {t('lcap.bundle.privateExportHeading', 'Export a private room for offline sharing')}
          </h3>
          <p className="text-sm text-ink-muted">
            {t(
              'lcap.bundle.privateExportIntro',
              'Save an end-to-end-encrypted room as a file. Only its encrypted contents travel — nothing is readable without the room keys, which never leave your devices. Another member can re-import it to catch up offline.',
            )}
          </p>
          <ul className="flex flex-col gap-2">
            {privateRooms.map((room) => (
              <li key={room.roomId} className="flex items-center justify-between gap-3">
                <span className="text-sm text-ink">{room.name}</span>
                <Button
                  variant="secondary"
                  size="md"
                  loading={privateExport.phase === 'building'}
                  onClick={() => void doPrivateExport(room.roomId)}
                >
                  {t('lcap.bundle.privateExportFile', 'Export encrypted file')}
                </Button>
              </li>
            ))}
          </ul>
          {privateExport.phase === 'done' ? (
            <p className="text-sm text-success-on-soft" role="status">
              {t('lcap.bundle.privateExportDone', 'Saved {filename} (encrypted contents only).', {
                filename: privateExport.filename,
              })}
            </p>
          ) : null}
          {privateExport.phase === 'error' ? (
            <p className="text-sm text-error-on-soft" role="alert">
              {t('lcap.bundle.privateExportError', 'Could not prepare the encrypted export.')}
            </p>
          ) : null}
        </section>
      ) : null}

      <section
        className="flex flex-col gap-3 rounded-lg bg-surface-sunken p-4"
        aria-labelledby="lcap-import-heading"
      >
        <h3 id="lcap-import-heading" className="text-base font-semibold text-ink">
          {t('lcap.bundle.importHeading', 'Import an offline bundle')}
        </h3>
        <p className="text-sm text-ink-muted">
          {t(
            'lcap.bundle.importIntro',
            'Open a .licio-bundle someone shared with you. Every item is checked before anything is shown, and nothing is trusted beyond what its proofs establish.',
          )}
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept=".licio-bundle,application/vnd.licio.lcap-pack"
          className="text-sm text-ink"
          aria-label={t('lcap.bundle.chooseFile', 'Choose a bundle file')}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onFileChosen(file);
          }}
        />

        {importState.phase === 'reading' ||
        importState.phase === 'committing' ||
        importState.phase === 'private_committing' ? (
          <p className="text-sm text-ink-muted" role="status">
            {importState.phase === 'reading'
              ? t('lcap.bundle.reading', 'Checking the file…')
              : t('lcap.bundle.committing', 'Importing…')}
          </p>
        ) : null}

        {importState.phase === 'summarized' ? (
          <div className="flex flex-col gap-2 rounded-md bg-info-soft p-3 text-info-on-soft">
            <Badge tone="info">{t('lcap.bundle.summaryHeading', 'Before importing')}</Badge>
            <ul className="list-disc pl-5 text-sm">
              <li>
                {t(
                  'lcap.bundle.summaryCounts',
                  '{records} posts, {proofs} proofs, {blocks} media — about {size}',
                  {
                    records: importState.summary.byKind.record,
                    proofs: importState.summary.byKind.proof,
                    blocks: importState.summary.byKind.block,
                    size: formatBytes(importState.summary.totalPayloadBytes),
                  },
                )}
              </li>
              <li>
                {t('lcap.bundle.summaryIntegrity', '{ok} of {total} pass integrity checks', {
                  ok: importState.summary.integrityVerified,
                  total: importState.summary.totalObjects,
                })}
              </li>
            </ul>
            <div className="flex gap-2">
              <Button variant="primary" size="md" onClick={doImport}>
                {t('lcap.bundle.importConfirm', 'Import')}
              </Button>
              <Button variant="ghost" size="md" onClick={() => setImportState({ phase: 'idle' })}>
                {t('lcap.common.cancel', 'Cancel')}
              </Button>
            </div>
          </div>
        ) : null}

        {importState.phase === 'done' ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-success-on-soft" role="status">
              {t(
                'lcap.bundle.importDone',
                'Imported {records} posts and {proofs} proofs. They stay unverified until their authorship is confirmed.',
                {
                  records: importState.counts.records,
                  proofs: importState.counts.proofs,
                },
              )}
            </p>
            {/* The honest §34 trust badge for what the import actually granted: records
                land at `integrity_verified` / `peer_stored` (WS-R.8.3), which maps to
                "Cannot verify yet…" — never a claim the projection has not made. */}
            {importState.counts.records > 0 ? (
              <TrustBadge trust="integrity_verified" liveness="peer_stored" />
            ) : null}
            {importState.counts.missingCids.length > 0 ? (
              <QuarantineNotice missingCids={importState.counts.missingCids} />
            ) : null}
          </div>
        ) : null}

        {/* WS-R.16.1 — a private-encrypted bundle: the public store refused it; offer to
            route it into a chosen device-local private room via the cross-plane bridge. */}
        {importState.phase === 'private_routed' ? (
          <div className="flex flex-col gap-2 rounded-md bg-info-soft p-3 text-info-on-soft">
            <Badge tone="info">{t('lcap.bundle.privateImportHeading', 'Encrypted bundle')}</Badge>
            <p className="text-sm">
              {t(
                'lcap.bundle.privateImportIntro',
                'This is an end-to-end-encrypted private room bundle. Its contents stay encrypted — they are checked against a room’s keys before anything is accepted. Choose which of your private rooms to add it to.',
              )}
            </p>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('lcap.bundle.privateImportTarget', 'Add to private room')}</span>
              <select
                className="rounded-md border border-line bg-surface p-2 text-ink"
                value={privateTargetRoomId}
                onChange={(event) => setPrivateTargetRoomId(event.target.value)}
              >
                {privateRooms.map((room) => (
                  <option key={room.roomId} value={room.roomId}>
                    {room.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="md"
                disabled={!privateTargetRoomId}
                onClick={doPrivateImport}
              >
                {t('lcap.bundle.privateImportConfirm', 'Add to room')}
              </Button>
              <Button variant="ghost" size="md" onClick={() => setImportState({ phase: 'idle' })}>
                {t('lcap.common.cancel', 'Cancel')}
              </Button>
            </div>
          </div>
        ) : null}

        {importState.phase === 'private_done' ? (
          <div className="flex flex-col gap-2">
            {/*
              Three outcomes, three sentences — and only the ones that happened.
              The done line used to end "The rest were held back — they do not
              verify against this room's keys" UNCONDITIONALLY, which is false
              for the most likely thing a person does with a private bundle:
              re-import their own backup into the room it came from.  The engine
              treats an exact re-receive as idempotent (`existingSig ===
              envelope.signature` → neither accepted nor quarantined), so that
              import reads "Added 0 of 12" and then accuses all twelve of failing
              verification — telling someone their intact backup is corrupt.
            */}
            <p className="text-sm text-success-on-soft" role="status">
              {t(
                'lcap.bundle.privateImportDone',
                'Added {accepted} of {recovered} encrypted items to the room.',
                {
                  accepted: importState.counts.accepted,
                  recovered: importState.counts.recovered,
                },
              )}
            </p>
            {alreadyPresent > 0 ? (
              <p className="text-sm text-ink-muted">
                {t(
                  'lcap.bundle.privateImportAlreadyPresent',
                  '{present} item(s) were already in this room — nothing to add.',
                  { present: alreadyPresent },
                )}
              </p>
            ) : null}
            {awaitingKeys > 0 ? (
              <p className="text-sm text-ink-muted">
                {t(
                  'lcap.bundle.privateImportPending',
                  '{pending} item(s) are waiting for a room key or device record and will appear once it arrives.',
                  { pending: awaitingKeys },
                )}
              </p>
            ) : null}
            {importState.counts.quarantined > 0 || importState.counts.rejected > 0 ? (
              <p className="text-sm text-ink-muted">
                {t(
                  'lcap.bundle.privateImportHeldBack',
                  '{held} item(s) were not added (wrong room keys or malformed).',
                  { held: importState.counts.quarantined + importState.counts.rejected },
                )}
              </p>
            ) : null}
          </div>
        ) : null}

        {importState.phase === 'rejected' ? (
          <p className="text-sm text-error-on-soft" role="alert">
            {t('lcap.bundle.rejected', 'That file could not be imported ({reason}).', {
              reason: importState.status,
            })}
          </p>
        ) : null}
      </section>
    </div>
  );
}
