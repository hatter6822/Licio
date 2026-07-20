// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.2 — the §22.3 QR micro-bundle UI: it offers a SHOW half only when a payload
// is given (refusing an oversized payload), always offers the image IMPORT half, and —
// crucially — never renders a decoded payload before the user confirms (the content-free
// `describeQrPayload` summary precedes import).  jsdom has no canvas/createImageBitmap,
// so the deep encode/decode round-trip is covered by `lcap/transports/qr/qr.test.ts`;
// here we assert the UI states and the confirm gate.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QR_MAX_PAYLOAD_BYTES } from '../../../lcap/transports/qr/index.js';
import { checkA11y } from '../../../test/axe.js';
import { QrMicroBundle } from './QrMicroBundle.js';

describe('QrMicroBundle (§22.3)', () => {
  it('shows only the import half when no payload is given', () => {
    render(<QrMicroBundle />);
    expect(screen.getByRole('heading', { name: /import from a qr image/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /show as a qr code/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/choose a qr image/i)).toBeInTheDocument();
  });

  it('refuses an oversized payload', () => {
    const big = new Uint8Array(QR_MAX_PAYLOAD_BYTES + 1).fill(0x41);
    render(<QrMicroBundle payload={big} />);
    fireEvent.click(screen.getByRole('button', { name: /show qr code/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/too large/i);
  });

  it('shows a small payload without a too-large alert', () => {
    cleanup();
    const small = new Uint8Array([0x68, 0x69]); // "hi"
    render(<QrMicroBundle payload={small} />);
    fireEvent.click(screen.getByRole('button', { name: /show qr code/i }));
    expect(screen.queryByText(/too large/i)).not.toBeInTheDocument();
  });

  it('reports no QR found when the chosen image cannot be decoded (no camera in jsdom)', async () => {
    const onImport = vi.fn();
    const user = userEvent.setup();
    render(<QrMicroBundle onImport={onImport} />);
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText(/choose a qr image/i), file);
    // jsdom has no createImageBitmap/canvas → fileToImageData returns null → no_qr.
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/no qr code/i));
    // The content-free gate held: nothing was imported without an explicit confirm.
    expect(onImport).not.toHaveBeenCalled();
  });

  it('reports no QR found (never hangs on the spinner) when decoding throws', async () => {
    cleanup();
    // Force fileToImageData past its capability guard, then have createImageBitmap
    // REJECT — the try/catch must route the rejection to the same no_qr state
    // rather than leaving the reader stuck on 'reading' with an unhandled rejection.
    const g = globalThis as unknown as {
      createImageBitmap?: unknown;
      OffscreenCanvas?: unknown;
    };
    const priorCreate = g.createImageBitmap;
    const priorCanvas = g.OffscreenCanvas;
    g.createImageBitmap = vi.fn().mockRejectedValue(new Error('undecodable'));
    g.OffscreenCanvas = class {};
    try {
      const onImport = vi.fn();
      const user = userEvent.setup();
      render(<QrMicroBundle onImport={onImport} />);
      const file = new File([new Uint8Array([1, 2, 3])], 'corrupt.png', { type: 'image/png' });
      await user.upload(screen.getByLabelText(/choose a qr image/i), file);
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/no qr code/i));
      expect(onImport).not.toHaveBeenCalled();
    } finally {
      g.createImageBitmap = priorCreate;
      g.OffscreenCanvas = priorCanvas;
    }
  });

  it('passes the accessibility audit', async () => {
    const { container } = render(<QrMicroBundle payload={new Uint8Array([1, 2])} />);
    await checkA11y(container);
  });
});
