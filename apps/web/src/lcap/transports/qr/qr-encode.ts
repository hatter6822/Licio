// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A hand-rolled QR encoder (OFFLINE_SPEC §22.3, WS-R.15.2) — byte mode, EC level L,
// versions 1–4 (single block), which covers the card's TINY control material
// (checkpoint/revocation frontier, room invite, relay contact card, a small signed
// notice).  Hand-rolled to stay dependency-free on the ENCODE side (the §31.1 ethos);
// the harder DECODE-from-a-photo path uses jsQR.  Correctness is proven by a jsQR
// round-trip (encode → render → decode) in the test, so any matrix/mask/format bug is
// caught.  A payload that exceeds the v4-L byte capacity is rejected (QR is for tiny
// control objects only).

// --- GF(256) for Reed–Solomon (primitive polynomial 0x11D). -----------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
})();

const exp = (i: number): number => EXP[i] as number;
const log = (i: number): number => LOG[i] as number;

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : exp(log(a) + log(b));
}

/** The Reed–Solomon generator polynomial for `degree` EC codewords. */
function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] as number) ^ gfMul(poly[j] as number, 1);
      next[j + 1] = (next[j + 1] as number) ^ gfMul(poly[j] as number, exp(i));
    }
    poly = next;
  }
  return poly;
}

/** The `ecCount` Reed–Solomon error-correction codewords for `data`. */
function rsEncode(data: readonly number[], ecCount: number): number[] {
  const gen = rsGenerator(ecCount);
  const res = new Array<number>(data.length + ecCount).fill(0);
  for (let i = 0; i < data.length; i++) res[i] = data[i] as number;
  for (let i = 0; i < data.length; i++) {
    const coef = res[i] as number;
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      res[i + j] = (res[i + j] as number) ^ gfMul(gen[j] as number, coef);
    }
  }
  return res.slice(data.length);
}

// --- Version table (EC level L, single block, byte mode). -------------------------
interface VersionSpec {
  readonly dataCodewords: number;
  readonly ecCodewords: number;
  readonly align: readonly number[]; // alignment-pattern centre coordinates
}

const VERSIONS: Readonly<Record<number, VersionSpec>> = {
  1: { dataCodewords: 19, ecCodewords: 7, align: [] },
  2: { dataCodewords: 34, ecCodewords: 10, align: [6, 18] },
  3: { dataCodewords: 55, ecCodewords: 15, align: [6, 22] },
  4: { dataCodewords: 80, ecCodewords: 20, align: [6, 26] },
};

function versionSpec(version: number): VersionSpec {
  return VERSIONS[version] as VersionSpec;
}

/** The smallest v1–4 that fits `byteLen` bytes in byte mode (4-bit mode + 8-bit count). */
function chooseVersion(byteLen: number): number {
  for (const v of [1, 2, 3, 4]) {
    // overhead: 4-bit mode + 8-bit count + 4-bit terminator ≈ 2 codewords headroom.
    if (byteLen + 2 <= versionSpec(v).dataCodewords) return v;
  }
  throw new RangeError(
    `payload too large for a v1–4 QR (max ${versionSpec(4).dataCodewords - 2} bytes)`,
  );
}

// --- Bit buffer. ------------------------------------------------------------------
class BitBuffer {
  readonly bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

/** Encode the data + pad codewords for `version` (byte mode, EC L). */
function dataCodewords(payload: Uint8Array, version: number): number[] {
  const spec = versionSpec(version);
  const buf = new BitBuffer();
  buf.put(0b0100, 4); // byte mode
  buf.put(payload.length, 8); // count indicator (8 bits for v1–9)
  for (const byte of payload) buf.put(byte, 8);
  // Terminator (up to 4 zero bits) + pad to a byte boundary.
  const capacityBits = spec.dataCodewords * 8;
  for (let i = 0; i < 4 && buf.bits.length < capacityBits; i++) buf.bits.push(0);
  while (buf.bits.length % 8 !== 0) buf.bits.push(0);
  const codewords: number[] = [];
  for (let i = 0; i < buf.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (buf.bits[i + j] as number);
    codewords.push(byte);
  }
  // Pad bytes (0xEC, 0x11 alternating) to fill the data capacity.
  const pad = [0xec, 0x11];
  let p = 0;
  while (codewords.length < spec.dataCodewords) codewords.push(pad[p++ % 2] as number);
  return codewords;
}

// --- Matrix construction. ---------------------------------------------------------
type Matrix = Int8Array[]; // -1 = reserved/unset, 0/1 = module value

function mget(m: Matrix, r: number, c: number): number {
  return (m[r] as Int8Array)[c] as number;
}
function mset(m: Matrix, r: number, c: number, v: number): void {
  (m[r] as Int8Array)[c] = v;
}

function blankMatrix(size: number): Matrix {
  return Array.from({ length: size }, () => new Int8Array(size).fill(-1));
}

function placeFinder(m: Matrix, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const onRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const dark =
        onRing &&
        (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      mset(m, rr, cc, dark ? 1 : 0);
    }
  }
}

function placeAlignment(m: Matrix, centres: readonly number[]): void {
  for (const r of centres) {
    for (const c of centres) {
      // Skip the three finder corners.
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= m.length - 9) || (r >= m.length - 9 && c <= 8)) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          mset(m, r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
        }
      }
    }
  }
}

function placeTimingAndDark(m: Matrix): void {
  const size = m.length;
  for (let i = 8; i < size - 8; i++) {
    if (mget(m, 6, i) === -1) mset(m, 6, i, i % 2 === 0 ? 1 : 0);
    if (mget(m, i, 6) === -1) mset(m, i, 6, i % 2 === 0 ? 1 : 0);
  }
  mset(m, size - 8, 8, 1); // the always-dark module
}

/** Reserve (mark -2) the format-info areas so data placement skips them. */
function reserveFormat(m: Matrix): void {
  const size = m.length;
  for (let i = 0; i <= 8; i++) {
    if (mget(m, 8, i) === -1) mset(m, 8, i, -2);
    if (mget(m, i, 8) === -1) mset(m, i, 8, -2);
  }
  for (let i = 0; i < 8; i++) {
    if (mget(m, 8, size - 1 - i) === -1) mset(m, 8, size - 1 - i, -2);
    if (mget(m, size - 1 - i, 8) === -1) mset(m, size - 1 - i, 8, -2);
  }
}

/** Place the data+EC bitstream into the matrix in the standard upward/downward zigzag. */
function placeData(m: Matrix, bits: readonly number[]): void {
  const size = m.length;
  let bit = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (mget(m, row, cc) !== -1) continue;
        mset(m, row, cc, (bits[bit++] ?? 0) as number);
      }
    }
    upward = !upward;
  }
}

const MASKS: ReadonlyArray<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** BCH(15,5) format-info bits for EC level L (01) + mask, with the standard XOR mask. */
function formatBits(maskIndex: number): number[] {
  const data = (0b01 << 3) | maskIndex; // EC level L = 0b01
  let bch = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((bch >> i) & 1) bch ^= 0b10100110111 << (i - 10);
  }
  const format = ((data << 10) | bch) ^ 0b101010000010010;
  const out: number[] = [];
  for (let i = 14; i >= 0; i--) out.push((format >> i) & 1);
  return out;
}

function writeFormat(m: Matrix, maskIndex: number): void {
  const size = m.length;
  const bits = formatBits(maskIndex);
  const tl: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i++) tl.push([8, i]);
  tl.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i <= 14; i++) tl.push([14 - i, 8]);
  tl.forEach(([r, c], i) => {
    mset(m, r, c, bits[i] as number);
  });
  for (let i = 0; i <= 7; i++) mset(m, size - 1 - i, 8, bits[i] as number);
  for (let i = 8; i <= 14; i++) mset(m, 8, size - 15 + i, bits[i] as number);
}

/** Apply `maskIndex` to every NON-function module of a fresh copy. */
function applyMask(base: Matrix, functionMap: readonly boolean[][], maskIndex: number): Matrix {
  const m = base.map((row) => Int8Array.from(row));
  const fn = MASKS[maskIndex] as (r: number, c: number) => boolean;
  for (let r = 0; r < m.length; r++) {
    for (let c = 0; c < m.length; c++) {
      if (functionMap[r]?.[c]) continue;
      const v = mget(base, r, c);
      mset(m, r, c, fn(r, c) ? v ^ 1 : v);
    }
  }
  return m;
}

/** Penalty rule 1 (runs of 5+ same-colour modules) — enough to pick a decodable mask. */
function penalty(m: Matrix): number {
  const size = m.length;
  let score = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      for (const [dr, dc] of [
        [0, 1],
        [1, 0],
      ] as const) {
        let run = 1;
        while (
          c + dc * run < size &&
          r + dr * run < size &&
          mget(m, r + dr * run, c + dc * run) === mget(m, r, c)
        ) {
          run++;
        }
        if (run >= 5) score += 3 + (run - 5);
      }
    }
  }
  return score;
}

/** Encode `payload` to a QR module matrix (1 = dark) for versions 1–4, EC L. */
export function encodeQr(payload: Uint8Array): {
  size: number;
  modules: boolean[][];
  version: number;
} {
  const version = chooseVersion(payload.length);
  const spec = versionSpec(version);
  const data = dataCodewords(payload, version);
  const ec = rsEncode(data, spec.ecCodewords);
  const bits: number[] = [];
  for (const byte of [...data, ...ec]) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);

  const size = 17 + version * 4;
  const base = blankMatrix(size);
  placeFinder(base, 0, 0);
  placeFinder(base, 0, size - 7);
  placeFinder(base, size - 7, 0);
  placeAlignment(base, spec.align);
  placeTimingAndDark(base);
  reserveFormat(base);
  // Capture the function-pattern map (every non-data cell) BEFORE placing data.
  const functionMap = base.map((row) => Array.from(row, (v) => v !== -1));
  placeData(base, bits);

  // Choose the lowest-penalty mask, then write its format info.
  let bestScore = Number.POSITIVE_INFINITY;
  let bestMatrix: Matrix = base;
  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(base, functionMap, mask);
    writeFormat(masked, mask);
    const score = penalty(masked);
    if (score < bestScore) {
      bestScore = score;
      bestMatrix = masked;
    }
  }

  const modules = bestMatrix.map((row) => Array.from(row, (v) => v === 1));
  return { size, modules, version };
}
