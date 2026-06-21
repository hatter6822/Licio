// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Render a QR module matrix to an RGBA pixel buffer (WS-R.15.2) — for on-screen display
// and for the jsQR round-trip test.  A quiet zone (the required ≥4-module light border)
// surrounds the matrix; each module is scaled to `scale` pixels.  Dark → black, light →
// white.  The output shape matches the `{ data, width, height }` an `ImageData` (and
// jsQR) expects, so the same function serves the canvas and the decoder test.

export interface RenderedQr {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export interface RenderOptions {
  readonly scale?: number;
  readonly quietZone?: number;
}

export function renderToImageData(
  modules: readonly boolean[][],
  options: RenderOptions = {},
): RenderedQr {
  const scale = options.scale ?? 4;
  const quiet = options.quietZone ?? 4;
  const moduleCount = modules.length;
  const dimModules = moduleCount + quiet * 2;
  const size = dimModules * scale;
  const data = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mr = Math.floor(y / scale) - quiet;
      const mc = Math.floor(x / scale) - quiet;
      const dark =
        mr >= 0 && mr < moduleCount && mc >= 0 && mc < moduleCount && modules[mr]?.[mc] === true;
      const v = dark ? 0 : 255;
      const i = (y * size + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: size, height: size };
}
