// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §27.1 resource-cap single source of truth (OFFLINE_SPEC §27.1, WS-R.14.1a).
// One frozen config object holds EVERY parser-path limit — pack/header/table/frame/
// uncompressed sizes, the compression expansion ratio, manifest entries, dependency
// depth/fan-out/node counts, missing-deps and proofs per record, and the import-batch
// signature-failure / quarantine-byte / CPU-time bounds — so no parser path
// hard-codes a limit of its own.  The reader (WS-R.4.2), the decompressor
// (WS-R.3.4), the dependency-graph guard (WS-R.14.1b), and the server parse
// (WS-R.12.1a) all source their limits from here; a static check asserts it.
//
// Caps are profile-tunable (an old phone runs tighter than a server) but NEVER
// disable-able: every value is clamped into `[1, ceiling]`, so a hostile or buggy
// override can neither zero a cap (disable it) nor raise it past the server ceiling
// nor set it to Infinity (unlimited).  A breach surfaces `rejected_resource_limit`
// naming the violated cap (the §16.11 wire code).

/** The full §27.1 cap set — one number per enforced limit. */
export interface ResourceCaps {
  // --- pack / frame structure (the WS-R.4.2 streaming reader) ---
  readonly maxPackBytes: number;
  readonly maxHeaderBytes: number;
  readonly maxTableBytes: number;
  readonly maxFrameHeaderBytes: number;
  readonly maxFramePayloadBytes: number;
  readonly maxManifestEntries: number;
  // --- compression (the WS-R.3.4 bounded decompressor) ---
  readonly maxUncompressedBytes: number;
  readonly maxExpansionRatio: number;
  // --- declared dependency graph (the WS-R.14.1b guard) ---
  readonly maxGraphNodes: number;
  readonly maxFanOut: number;
  readonly maxDependencyDepth: number;
  readonly maxMissingDepsPerObject: number;
  readonly maxProofsPerRecord: number;
  // --- import batch (the WS-R.12.1a server parse) ---
  readonly maxSignatureFailuresPerImport: number;
  readonly maxQuarantineBytes: number;
  readonly maxCpuTimeMsPerImportBatch: number;
}

/** A cap field name (carried by a breach for audit; never a record value). */
export type CapName = keyof ResourceCaps;

/**
 * The server profile — the most generous caps, and the tuning CEILING every other
 * profile is clamped against.  A cap can be tuned no higher than its value here.
 */
export const SERVER_CAPS: ResourceCaps = Object.freeze({
  maxPackBytes: 64 * 1024 * 1024,
  maxHeaderBytes: 64 * 1024,
  maxTableBytes: 4 * 1024 * 1024,
  maxFrameHeaderBytes: 4 * 1024,
  maxFramePayloadBytes: 16 * 1024 * 1024,
  maxManifestEntries: 100_000,
  maxUncompressedBytes: 8 * 1024 * 1024,
  maxExpansionRatio: 100,
  maxGraphNodes: 4096,
  maxFanOut: 64,
  maxDependencyDepth: 64,
  maxMissingDepsPerObject: 64,
  maxProofsPerRecord: 16,
  maxSignatureFailuresPerImport: 64,
  maxQuarantineBytes: 16 * 1024 * 1024,
  maxCpuTimeMsPerImportBatch: 5_000,
});

// A cap can never be disabled: the floor is 1 (one unit), never 0 or negative.
const CAP_FLOOR = 1;

/**
 * Tune a cap set: each field is `overrides[field] ?? ceiling[field]`, then clamped
 * into `[1, ceiling[field]]`.  A non-finite or over-ceiling value collapses to the
 * ceiling (never unlimited); a ≤ 0 value collapses to 1 (never disabled).  Integer.
 */
export function clampCaps(
  overrides: Partial<ResourceCaps>,
  ceiling: ResourceCaps = SERVER_CAPS,
): ResourceCaps {
  const out = {} as Record<CapName, number>;
  for (const key of Object.keys(ceiling) as CapName[]) {
    const max = ceiling[key];
    let value = overrides[key] ?? max;
    if (!Number.isFinite(value) || value > max) value = max; // never unlimited / above the ceiling
    if (value < CAP_FLOOR) value = CAP_FLOOR; // never disabled
    out[key] = Math.floor(value);
  }
  return Object.freeze(out) as ResourceCaps;
}

/**
 * The old-phone profile — tighter than the server in every dimension.  Built through
 * {@link clampCaps}, so it is provably ≤ {@link SERVER_CAPS} (and never unlimited).
 */
export const OLD_PHONE_CAPS: ResourceCaps = clampCaps({
  maxPackBytes: 8 * 1024 * 1024,
  maxHeaderBytes: 16 * 1024,
  maxTableBytes: 512 * 1024,
  maxFrameHeaderBytes: 2 * 1024,
  maxFramePayloadBytes: 4 * 1024 * 1024,
  maxManifestEntries: 8_192,
  maxUncompressedBytes: 2 * 1024 * 1024,
  maxExpansionRatio: 50,
  maxGraphNodes: 512,
  maxFanOut: 32,
  maxDependencyDepth: 32,
  maxMissingDepsPerObject: 32,
  maxProofsPerRecord: 8,
  maxSignatureFailuresPerImport: 16,
  maxQuarantineBytes: 2 * 1024 * 1024,
  maxCpuTimeMsPerImportBatch: 2_000,
});

/** The two named §27.1 profiles. */
export type CapProfile = 'server' | 'old_phone';

/** The frozen caps for a named profile. */
export function capsForProfile(profile: CapProfile): ResourceCaps {
  return profile === 'old_phone' ? OLD_PHONE_CAPS : SERVER_CAPS;
}

/** The result of a single cap check — `ok`, or a named-cap `rejected_resource_limit`. */
export type CapCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'rejected_resource_limit'; readonly cap: CapName };

/**
 * The single enforcement helper (non-throwing): is `value` within `caps[cap]`?  A
 * breach names the violated cap and carries the §16.11 `rejected_resource_limit`.
 */
export function checkCap(value: number, cap: CapName, caps: ResourceCaps): CapCheck {
  return value > caps[cap] ? { ok: false, reason: 'rejected_resource_limit', cap } : { ok: true };
}

/** A §27.1 cap breach — carries the violated cap name; `reason` is the §16.11 code. */
export class ResourceLimitError extends Error {
  override readonly name = 'ResourceLimitError';
  readonly reason = 'rejected_resource_limit' as const;
  constructor(readonly cap: CapName) {
    super(`resource cap exceeded: ${cap}`);
  }
}

/** The throwing form of {@link checkCap}: aborts with a {@link ResourceLimitError}. */
export function enforceCap(value: number, cap: CapName, caps: ResourceCaps): void {
  if (value > caps[cap]) throw new ResourceLimitError(cap);
}
