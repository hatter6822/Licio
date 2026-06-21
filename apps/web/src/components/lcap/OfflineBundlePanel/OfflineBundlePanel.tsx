// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.1a/b — the offline `.licio-bundle` export/import surface.  Orchestrates the
// tested client-local flows (`bundle-export` / `bundle-import`) so a user can hand a
// room's content to a peer on a USB stick / file share with no connectivity, and
// import a bundle a peer handed them — running the REAL @licio/lcap pack codec in the
// browser (loaded as a lazy chunk).  The surface is honest about trust and disclosure:
//   - EXPORT shows the §26.2 disclosure (which rooms, media, size, "recipients may
//     copy onward") BEFORE producing any file;
//   - IMPORT shows the pre-render summary (counts, lanes, rooms, integrity) BEFORE
//     committing, then reports the per-object outcome — quarantining missing-dependency
//     records — and never implies a trust the projection has not granted (§34, §8.3).

import type { ExportDisclosure, ParsedPack } from '@licio/lcap';
import { useCallback, useRef, useState } from 'react';
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
import { cn } from '../../../lib/cn.js';
import { Badge } from '../../ui/Badge/index.js';
import { Button } from '../../ui/Button/index.js';
import { QuarantineNotice } from '../OfflineStates/index.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ExportState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'preparing' }
  | { readonly phase: 'ready'; readonly data: RoomExport & { disclosure: ExportDisclosure } }
  | { readonly phase: 'done'; readonly filename: string }
  | { readonly phase: 'error'; readonly message: string };

type ImportState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'reading' }
  | { readonly phase: 'summarized'; readonly pack: ParsedPack; readonly summary: BundleSummary }
  | { readonly phase: 'committing' }
  | { readonly phase: 'done'; readonly counts: CommitCounts }
  | { readonly phase: 'rejected'; readonly status: string };

export interface OfflineBundlePanelProps {
  /** The room to export (the export section is shown only when a room is in context). */
  readonly roomHash?: string;
  /** A human label for the room, shown in the export heading. */
  readonly roomLabel?: string;
  /** High-risk posture (stealth/emergency): generic export filename (§26.3). */
  readonly highRisk?: boolean;
  readonly className?: string;
}

export function OfflineBundlePanel({
  roomHash,
  roomLabel,
  highRisk = false,
  className,
}: OfflineBundlePanelProps): React.ReactElement {
  const t = useT();
  const [exportState, setExportState] = useState<ExportState>({ phase: 'idle' });
  const [importState, setImportState] = useState<ImportState>({ phase: 'idle' });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const prepareExport = useCallback(async () => {
    if (!roomHash) return;
    setExportState({ phase: 'preparing' });
    try {
      const data = await prepareRoomExport(roomHash);
      setExportState({ phase: 'ready', data });
    } catch {
      setExportState({
        phase: 'error',
        message: t('lcap.bundle.exportError', 'Could not prepare the export.'),
      });
    }
  }, [roomHash, t]);

  const doExport = useCallback(async () => {
    if (exportState.phase !== 'ready' || !roomHash) return;
    try {
      const bytes = await buildBundle({
        objects: exportState.data.objects,
        disclosure: exportState.data.disclosure,
      });
      const filename = await bundleFilename({ highRisk, roomHash });
      await downloadBundle(bytes, filename);
      setExportState({ phase: 'done', filename });
    } catch {
      setExportState({
        phase: 'error',
        message: t('lcap.bundle.exportError', 'Could not prepare the export.'),
      });
    }
  }, [exportState, roomHash, highRisk, t]);

  const onFileChosen = useCallback(async (file: File) => {
    setImportState({ phase: 'reading' });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const outcome = await readBundleForImport(bytes);
      if (!outcome.ok) {
        setImportState({ phase: 'rejected', status: outcome.status });
        return;
      }
      setImportState({ phase: 'summarized', pack: outcome.pack, summary: outcome.summary });
    } catch {
      setImportState({ phase: 'rejected', status: 'unreadable' });
    }
  }, []);

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

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      {roomHash ? (
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

        {importState.phase === 'reading' || importState.phase === 'committing' ? (
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
            {importState.counts.missingCids.length > 0 ? (
              <QuarantineNotice missingCids={importState.counts.missingCids} />
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
