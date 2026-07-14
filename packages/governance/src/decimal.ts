// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Exact decimal arithmetic for treasury amounts (WS-U kernel / WS-L gateway).
// IEEE-754 doubles cannot represent minor-unit (wei-scale) amounts above 2^53
// exactly, so cap comparisons on `number` are mathematically unsound for
// on-chain assets (1 ETH = 10^18 wei > 2^53).  This module gives the kernel
// exact semantics over `number | string` amounts: values are normalized to a
// sign + scaled-bigint representation and compared/added with integer math —
// no floats, no precision loss, deterministic for any 78-digit uint256 string.
//
// A `number` input is interpreted via its shortest round-trip decimal
// representation (`String(n)`, including exponent forms like `1e+21`), i.e. as
// the decimal the author wrote — preserving the existing kernel behaviour for
// in-range values while making string amounts exact.

export type DecimalInput = number | string;

/** Canonical parsed decimal: value = (neg ? -1 : 1) * units / 10^scale. */
interface ParsedDecimal {
  neg: boolean;
  units: bigint;
  scale: number;
}

const DECIMAL_RE = /^[+-]?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** Whether a string is a valid plain/exponent decimal literal. */
export function isDecimalString(value: string): boolean {
  return DECIMAL_RE.test(value);
}

function parseDecimalString(value: string): ParsedDecimal {
  const match = DECIMAL_RE.exec(value);
  if (!match) throw new Error(`not a decimal literal: "${value}"`);
  const neg = value.startsWith('-');
  const whole = match[1] ?? '0';
  const frac = match[2] ?? '';
  const exp = match[3] !== undefined ? Number.parseInt(match[3], 10) : 0;

  let units = BigInt(whole + frac);
  let scale = frac.length - exp;
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { neg: neg && units !== 0n, units, scale };
}

/** Parse a `number | string` amount exactly (throws on NaN/±Infinity/garbage). */
function parseDecimal(input: DecimalInput): ParsedDecimal {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('amount must be finite');
    return parseDecimalString(String(input));
  }
  return parseDecimalString(input);
}

/** True when the input parses as a valid finite decimal. */
export function isValidDecimal(input: DecimalInput): boolean {
  try {
    parseDecimal(input);
    return true;
  } catch {
    return false;
  }
}

/** True when the (valid) decimal is strictly negative. */
export function decIsNegative(input: DecimalInput): boolean {
  return parseDecimal(input).neg;
}

/** Align two parsed decimals to a common scale and return signed unit values. */
function aligned(a: ParsedDecimal, b: ParsedDecimal): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  const ua = a.units * 10n ** BigInt(scale - a.scale) * (a.neg ? -1n : 1n);
  const ub = b.units * 10n ** BigInt(scale - b.scale) * (b.neg ? -1n : 1n);
  return { a: ua, b: ub, scale };
}

/** Exact three-way comparison: -1 (a < b), 0 (equal), 1 (a > b). */
export function decCompare(x: DecimalInput, y: DecimalInput): -1 | 0 | 1 {
  const { a, b } = aligned(parseDecimal(x), parseDecimal(y));
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Render a signed scaled value as a canonical decimal string (no trailing zeros). */
function render(value: bigint, scale: number): string {
  const neg = value < 0n;
  let digits = (neg ? -value : value).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    const whole = digits.slice(0, -scale);
    const frac = digits.slice(-scale).replace(/0+$/, '');
    digits = frac.length > 0 ? `${whole}.${frac}` : whole;
  }
  return digits === '0' ? '0' : `${neg ? '-' : ''}${digits}`;
}

/** Exact sum as a canonical decimal string. */
export function decAdd(x: DecimalInput, y: DecimalInput): string {
  const pa = parseDecimal(x);
  const pb = parseDecimal(y);
  const { a, b, scale } = aligned(pa, pb);
  return render(a + b, scale);
}

/** Exact sum of a list (empty list ⇒ "0"). */
export function decSum(values: readonly DecimalInput[]): string {
  return values.reduce<string>((acc, v) => decAdd(acc, v), '0');
}

/**
 * Exact product as a canonical decimal string.  Units multiply and scales add,
 * so a quorum/threshold fraction times a weight total is exact — the WS-M
 * proposal tally compares `approve > decided × minAffirmativeFraction` without
 * ever rounding through a double (a 2/3 supermajority written as `0.667` is the
 * exact decimal the law-pack author wrote, not a binary approximation of it).
 */
export function decMul(x: DecimalInput, y: DecimalInput): string {
  const pa = parseDecimal(x);
  const pb = parseDecimal(y);
  const units = pa.units * pb.units;
  const neg = pa.neg !== pb.neg && units !== 0n;
  return render(neg ? -units : units, pa.scale + pb.scale);
}
