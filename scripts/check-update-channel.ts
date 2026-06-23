// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2b — `check:update-channel` (PRIVATE_SPEC §20.6, §22.4, §27.5; WS-O.3.2e).
// A structural CI gate asserting the hardened private-mode update path is wired
// the way the spec requires: the running bundle is VERIFIED — maintainer
// SIGNATURE + transparency-log INCLUSION + digest match — BEFORE activation, and
// an untrusted verdict LOCKS private rooms (keys sealed) instead of activating.
// Like the other `check:*` gates this is a fast source scanner (no build, no
// runtime); it proves the wiring EXISTS rather than re-running the crypto.
//
// It checks three things:
//   1. the pure verifier (`@licio/shared/update`) signs + checks log inclusion
//      AND verifies the bundle digest, and exposes the typed lock reasons;
//   2. the client gate (`apps/web/src/update`) verifies BEFORE unlock and locks
//      on failure with the §20.6 copy;
//   3. the service worker refuses a silent takeover by an unverified bundle.
//
// `runUpdateChannelGate(read)` is PURE over an injected file reader, so the
// self-test below proves the gate BITES when a required marker is removed.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');

export interface UpdateGateViolation {
  readonly file: string;
  readonly detail: string;
}

/** A file that MUST exist and contain ALL of `markers` (after a light strip). */
interface RequiredFile {
  /** Path relative to repo root. */
  readonly file: string;
  readonly markers: readonly string[];
}

/**
 * The structural requirements proving the verify-before-activate + lock-on-fail
 * wiring is present.  Each marker is a load-bearing token of that wiring; removing
 * one trips the gate.
 */
export const REQUIRED_FILES: readonly RequiredFile[] = [
  {
    // The pure verifier binds signature + transparency log + digest and exposes
    // the typed lock reasons + the activate/lock-rooms decision.
    file: 'packages/shared/src/update/verify.ts',
    markers: [
      'verifyUpdateManifest',
      'decideUpdateActivation',
      'verifyEd25519', // maintainer signature
      'verifyInclusion', // transparency-log membership
      'digestsMatch', // running-bundle digest binding
      "'signature_invalid'",
      "'not_in_transparency_log'",
      "'digest_mismatch'",
      "'stale'",
      "action: 'activate'",
      "action: 'lock-rooms'",
    ],
  },
  {
    // The inclusion check is a real RFC 9162 Merkle reconstruction (fail-closed).
    file: 'packages/shared/src/update/merkle.ts',
    markers: ['verifyInclusion', 'nodeHash', 'bytesEqual'],
  },
  {
    // The signed-manifest schema is STRICT and carries the digest + log proof.
    file: 'packages/shared/src/update/schema.ts',
    markers: ['bundle_digest', 'inclusion_proof', 'checkpoint', '.strict()'],
  },
  {
    // The client gate hashes the running bundle, verifies, and LOCKS on failure.
    file: 'apps/web/src/update/gate.ts',
    markers: [
      'assertPrivateBundleTrusted',
      'computeRunningBundleDigest', // verify-before-unlock: digest the RUNNING bundle
      'verifyUpdateManifest',
      'PRIVATE_BUNDLE_LOCK_MESSAGE', // the §20.6 lock copy
      "status: 'locked'",
    ],
  },
  {
    // The SW-pinning glue gates activation on a trusted verdict only.
    file: 'apps/web/src/update/sw-pinning.ts',
    markers: ['gateServiceWorkerActivation', 'allowActivate', 'privateBundleVerified'],
  },
  {
    // The service worker refuses a silent takeover by an unverified bundle.
    file: 'apps/web/public/sw-push.js',
    markers: ['privateBundleVerified', 'SKIP_WAITING'],
  },
];

/** A token that MUST NOT appear in the service worker (no remote dynamic code). */
const SW_FORBIDDEN: ReadonlyArray<{ pattern: RegExp; detail: string }> = [
  { pattern: /\beval\s*\(/, detail: 'sw eval()' },
  { pattern: /new\s+Function\s*\(/, detail: 'sw new Function()' },
  { pattern: /importScripts\s*\(\s*['"`]?\s*https?:/i, detail: 'sw remote importScripts' },
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

/**
 * Run the gate over an injected file reader (PURE).  Returns the list of
 * violations; empty ⇒ the wiring is present and the SW carries no remote code.
 */
export function runUpdateChannelGate(read: (relPath: string) => string): UpdateGateViolation[] {
  const violations: UpdateGateViolation[] = [];
  for (const { file, markers } of REQUIRED_FILES) {
    let code: string;
    try {
      code = stripComments(read(file));
    } catch {
      violations.push({ file, detail: 'required update-channel file not found' });
      continue;
    }
    for (const marker of markers) {
      if (!code.includes(marker)) {
        violations.push({ file, detail: `missing required wiring marker: ${marker}` });
      }
    }
    if (file.endsWith('sw-push.js')) {
      for (const { pattern, detail } of SW_FORBIDDEN) {
        if (pattern.test(code)) violations.push({ file, detail });
      }
    }
  }
  return violations;
}

function readFromDisk(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf-8');
}

function main(): void {
  const violations = runUpdateChannelGate(readFromDisk);
  if (violations.length > 0) {
    console.error('check:update-channel FAILED:');
    for (const v of violations) console.error(`  - ${v.file} — ${v.detail}`);
    process.exit(1);
  }
  console.log('check:update-channel: OK (verify signature + transparency log before activation)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
