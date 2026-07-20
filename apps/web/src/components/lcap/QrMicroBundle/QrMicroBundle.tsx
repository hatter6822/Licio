// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.2 — the §22.3 QR micro-bundle UI.  QR carries only TINY control material
// (a checkpoint/revocation frontier, a room invite / contact card, a small signed
// notice) — never bulk content.  Two halves:
//
//   - SHOW: encode a payload (≤ QR_MAX_PAYLOAD_BYTES) to a QR matrix and render it to a
//     canvas for another device to photograph.  Oversized payloads are refused.
//   - IMPORT: decode a QR from a user-supplied STILL IMAGE (no camera — the app-wide
//     `camera=()` permissions-policy blocks getUserMedia).  A CONTENT-FREE summary
//     (`describeQrPayload`: size + a coarse printable-prefix hint) is shown BEFORE
//     import so a hostile QR can never inject rendered content into the confirm step;
//     the raw payload is handed to `onImport` only on explicit confirmation.
//
// The QR codec is dependency-free on encode and lazily loads jsQR on decode; it does
// NOT import the `@licio/lcap` bundle codec, so this stays off that lazy chunk.

import { useCallback, useRef, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import {
  decodeQr,
  describeQrPayload,
  encodeQr,
  QR_MAX_PAYLOAD_BYTES,
  renderToImageData,
} from '../../../lcap/transports/qr/index.js';
import { cn } from '../../../lib/cn.js';
import { Badge } from '../../ui/Badge/index.js';
import { Button } from '../../ui/Button/index.js';

/** Read a user-supplied image File into the `{ data, width, height }` jsQR expects. */
async function fileToImageData(
  file: File,
): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return null;
  }
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return { data: image.data, width: image.width, height: image.height };
}

type ShowState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'shown' }
  | { readonly phase: 'too_large'; readonly size: number };

type ImportState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'reading' }
  | {
      readonly phase: 'summarized';
      readonly bytes: Uint8Array;
      readonly hint: string;
      readonly size: number;
    }
  | { readonly phase: 'no_qr' }
  | { readonly phase: 'imported' };

export interface QrMicroBundleProps {
  /** Optional tiny payload to offer for display (a contact card / signed notice). */
  readonly payload?: Uint8Array;
  /** Called with the raw decoded bytes ONLY after the user confirms the import. */
  readonly onImport?: (bytes: Uint8Array) => void;
  readonly className?: string;
}

export function QrMicroBundle({
  payload,
  onImport,
  className,
}: QrMicroBundleProps): React.ReactElement {
  const t = useT();
  const [showState, setShowState] = useState<ShowState>({ phase: 'idle' });
  const [importState, setImportState] = useState<ImportState>({ phase: 'idle' });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const show = useCallback(() => {
    if (!payload) return;
    if (payload.length > QR_MAX_PAYLOAD_BYTES) {
      setShowState({ phase: 'too_large', size: payload.length });
      return;
    }
    const { modules } = encodeQr(payload);
    const rendered = renderToImageData(modules, { scale: 6 });
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d') ?? null;
    if (canvas && ctx) {
      canvas.width = rendered.width;
      canvas.height = rendered.height;
      // Copy into a fresh, ArrayBuffer-backed buffer so the ImageData ctor accepts it
      // (the renderer's Uint8ClampedArray is structurally `ArrayBufferLike`).
      const buffer = new Uint8ClampedArray(rendered.data.length);
      buffer.set(rendered.data);
      ctx.putImageData(new ImageData(buffer, rendered.width, rendered.height), 0, 0);
    }
    setShowState({ phase: 'shown' });
  }, [payload]);

  const onFileChosen = useCallback(async (file: File) => {
    setImportState({ phase: 'reading' });
    try {
      const image = await fileToImageData(file);
      if (!image) {
        setImportState({ phase: 'no_qr' });
        return;
      }
      const bytes = await decodeQr(image);
      if (!bytes) {
        setImportState({ phase: 'no_qr' });
        return;
      }
      const { sizeBytes, hint } = describeQrPayload(bytes);
      setImportState({ phase: 'summarized', bytes, hint, size: sizeBytes });
    } catch {
      // A non-decodable image (createImageBitmap rejection, jsQR chunk-load
      // failure) routes to the same 'no QR found' state as a clean miss —
      // never leaving the reader stuck on the spinner or throwing unhandled.
      setImportState({ phase: 'no_qr' });
    }
  }, []);

  const confirmImport = useCallback(() => {
    if (importState.phase !== 'summarized') return;
    onImport?.(importState.bytes);
    setImportState({ phase: 'imported' });
  }, [importState, onImport]);

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      {payload ? (
        <section
          className="flex flex-col gap-3 rounded-lg bg-surface-sunken p-4"
          aria-labelledby="lcap-qr-show-heading"
        >
          <h3 id="lcap-qr-show-heading" className="text-base font-semibold text-ink">
            {t('lcap.qr.showHeading', 'Show as a QR code')}
          </h3>
          <p className="text-sm text-ink-muted">
            {t(
              'lcap.qr.showIntro',
              'Display this small control object as a QR code for another device to photograph. QR carries tiny control material only — never posts or media.',
            )}
          </p>
          {showState.phase === 'idle' ? (
            <div>
              <Button variant="secondary" size="md" onClick={show}>
                {t('lcap.qr.showAction', 'Show QR code')}
              </Button>
            </div>
          ) : null}
          {showState.phase === 'too_large' ? (
            <p className="text-sm text-error-on-soft" role="alert">
              {t(
                'lcap.qr.tooLarge',
                'Too large for a QR code ({size} of {max} bytes). QR is for tiny control objects only.',
                { size: showState.size, max: QR_MAX_PAYLOAD_BYTES },
              )}
            </p>
          ) : null}
          {/* The rendered QR image; the explanatory text above carries the meaning. */}
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={t('lcap.qr.canvasLabel', 'QR code for the control object')}
            className={cn('rounded bg-white', showState.phase === 'shown' ? '' : 'hidden')}
          />
        </section>
      ) : null}

      <section
        className="flex flex-col gap-3 rounded-lg bg-surface-sunken p-4"
        aria-labelledby="lcap-qr-import-heading"
      >
        <h3 id="lcap-qr-import-heading" className="text-base font-semibold text-ink">
          {t('lcap.qr.importHeading', 'Import from a QR image')}
        </h3>
        <p className="text-sm text-ink-muted">
          {t(
            'lcap.qr.importIntro',
            'Choose a photo of a QR code. Its contents are summarized — never shown raw — before you decide to import.',
          )}
        </p>
        <input
          type="file"
          accept="image/*"
          className="text-sm text-ink"
          aria-label={t('lcap.qr.chooseImage', 'Choose a QR image')}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onFileChosen(file);
          }}
        />
        {importState.phase === 'reading' ? (
          <p className="text-sm text-ink-muted" role="status">
            {t('lcap.qr.reading', 'Reading the image…')}
          </p>
        ) : null}
        {importState.phase === 'no_qr' ? (
          <p className="text-sm text-error-on-soft" role="alert">
            {t('lcap.qr.noQr', 'No QR code was found in that image.')}
          </p>
        ) : null}
        {importState.phase === 'summarized' ? (
          <div className="flex flex-col gap-2 rounded-md bg-info-soft p-3 text-info-on-soft">
            <Badge tone="info">{t('lcap.qr.summaryHeading', 'Before importing')}</Badge>
            <ul className="list-disc pl-5 text-sm">
              <li>
                {t('lcap.qr.summarySize', '{size} bytes of control material', {
                  size: importState.size,
                })}
              </li>
              <li>{t('lcap.qr.summaryHint', 'Looks like: {hint}', { hint: importState.hint })}</li>
            </ul>
            <div className="flex gap-2">
              <Button variant="primary" size="md" onClick={confirmImport}>
                {t('lcap.qr.importConfirm', 'Import')}
              </Button>
              <Button variant="ghost" size="md" onClick={() => setImportState({ phase: 'idle' })}>
                {t('lcap.common.cancel', 'Cancel')}
              </Button>
            </div>
          </div>
        ) : null}
        {importState.phase === 'imported' ? (
          <p className="text-sm text-success-on-soft" role="status">
            {t('lcap.qr.imported', 'Imported the control object.')}
          </p>
        ) : null}
      </section>
    </div>
  );
}
