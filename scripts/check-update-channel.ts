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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'apps', 'web', 'dist');
const DIST_ASSETS = join(DIST, 'assets');
const MANIFEST_FILE = join(DIST, 'update-manifest.json');
const KEYS_FILE = join(DIST, 'update-channel-keys.json');
const ARTIFACT_ID = 'private-p2p';

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
    // The PRODUCER builds + signs the manifest and commits the leaf to the log.
    file: 'packages/shared/src/update/produce.ts',
    markers: ['produceSignedManifest', 'appendLeaf', 'signCheckpoint', 'canonicalManifestBody'],
  },
  {
    // The append-only RFC 9162 transparency log (the WS-O.3.2b substrate).
    file: 'packages/shared/src/update/log.ts',
    markers: ['appendLeaf', 'proveInclusion', 'signCheckpoint', 'merkleRoot'],
  },
  {
    // The build-time producer hashes the running chunk, signs, logs, and emits.
    file: 'scripts/build-update-manifest.ts',
    markers: [
      'produceSignedManifest',
      'update-manifest.json',
      'LICIO_UPDATE_SIGNING_KEY', // signing key is a BUILD secret, never VITE_-prefixed
      'private-p2p',
    ],
  },
  {
    // Anti-rollback: the `stale` floor is persisted + read back (live, not dead).
    file: 'apps/web/src/update/anti-rollback.ts',
    markers: ['loadLastTrustedSequence', 'recordTrustedSequence'],
  },
  {
    // The §20.6 lock UI renders the verbatim copy and gates the room surface.
    file: 'apps/web/src/components/update/PrivateBundleGuard.tsx',
    markers: ['useUpdateGate', 'PRIVATE_BUNDLE_LOCK_MESSAGE', 'gate.locked'],
  },
  {
    // The signed-manifest schema is STRICT and carries the digest + log proof.
    file: 'packages/shared/src/update/schema.ts',
    markers: ['bundle_digest', 'inclusion_proof', 'checkpoint', '.strict()'],
  },
  {
    // The client gate hashes the running bundle, verifies, LOCKS on failure, and
    // persists the anti-rollback floor on a trusted verdict.
    file: 'apps/web/src/update/gate.ts',
    markers: [
      'assertPrivateBundleTrusted',
      'computeRunningBundleDigest', // verify-before-unlock: digest the RUNNING bundle
      'verifyUpdateManifest',
      'PRIVATE_BUNDLE_LOCK_MESSAGE', // the §20.6 lock copy
      "status: 'locked'",
      'recordTrustedSequence', // anti-rollback floor written on trust
    ],
  },
  {
    // The SW-pinning glue gates activation on a trusted verdict only.
    file: 'apps/web/src/update/sw-pinning.ts',
    markers: ['gateServiceWorkerActivation', 'allowActivate', 'privateBundleVerified'],
  },
  {
    // The real boot ARMS the pin: the update toast routes through gatedApplyUpdate
    // (verify-before-activate) instead of the bare SKIP_WAITING.
    file: 'apps/web/src/update/install-sw-pinning.ts',
    markers: ['gatedApplyUpdate', 'gateServiceWorkerActivation', 'privateBundleGated'],
  },
  {
    // The root layout wires the SW-update consent toast through the gated apply.
    file: 'apps/web/src/routes/__root.tsx',
    markers: ['gatedApplyUpdate'],
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

/** The PUBLIC-keys sidecar the producer emits (no secret material). */
interface KeysSidecar {
  readonly signerPublicKeys: string[];
  readonly logPublicKey: string;
}

/** The dist artifacts the produced-manifest verification reads (injectable). */
export interface ProducedArtifactIO {
  /** The raw built private-mode chunk bytes, or `undefined` if not exactly one. */
  readonly bundleBytes: () => Uint8Array | undefined;
  /** The parsed `update-manifest.json`, or `undefined` if absent/unparseable. */
  readonly manifest: () => unknown | undefined;
  /** The parsed keys sidecar, or `undefined` if absent/unparseable. */
  readonly keys: () => KeysSidecar | undefined;
}

/**
 * Verify the PRODUCED artifact end-to-end with the REAL verifier (PURE over an
 * injected `ProducedArtifactIO`): hash the built private-mode chunk, parse the
 * keys sidecar, and run `verifyUpdateManifest` — the same fail-closed path the
 * client runs.  Returns `[]` on a `trusted` verdict, or one violation describing
 * why the gate refuses (missing manifest/keys/chunk, forged signature,
 * absent-from-log, digest mismatch, …).  This is what makes the gate BITE on a
 * missing or forged manifest after a build.
 */
export async function verifyProducedManifest(
  io: ProducedArtifactIO,
): Promise<UpdateGateViolation[]> {
  // The shipped verify code lives in the BUILT shared package (the build job runs this
  // after `pnpm build`).  In a context WITHOUT a prior build — the vitest Test job runs
  // `pnpm test` with no build — fall back to the SOURCE: the verify logic is byte-identical,
  // so the gate's behaviour (and the tests that drive it) hold either way.
  const shared = (await import('../packages/shared/dist/update/index.js').catch(
    () => import('../packages/shared/src/update/index.js'),
  )) as {
    sha256Concat: (...parts: Uint8Array[]) => Promise<Uint8Array>;
    verifyUpdateManifest: (input: {
      manifest: unknown;
      expectedArtifactId: string;
      runningBundleDigest: string;
      trustedSignerPublicKeys: readonly string[];
      logPublicKey: string;
    }) => Promise<{ trusted: boolean; reason?: string }>;
  };

  const manifest = io.manifest();
  if (manifest === undefined) {
    return [
      {
        file: 'apps/web/dist/update-manifest.json',
        detail: 'no produced manifest — run `pnpm gen:update-manifest`',
      },
    ];
  }
  const keys = io.keys();
  if (keys === undefined) {
    return [
      { file: 'apps/web/dist/update-channel-keys.json', detail: 'no produced public-keys sidecar' },
    ];
  }
  const bundleBytes = io.bundleBytes();
  if (bundleBytes === undefined) {
    return [
      { file: 'apps/web/dist/assets', detail: `expected exactly one ${ARTIFACT_ID}-*.js chunk` },
    ];
  }
  const digest = await shared.sha256Concat(bundleBytes);
  const runningBundleDigest = Buffer.from(digest).toString('base64url');

  const verdict = await shared.verifyUpdateManifest({
    manifest,
    expectedArtifactId: ARTIFACT_ID,
    runningBundleDigest,
    trustedSignerPublicKeys: keys.signerPublicKeys,
    logPublicKey: keys.logPublicKey,
  });
  if (!verdict.trusted) {
    return [
      {
        file: 'apps/web/dist/update-manifest.json',
        detail: `produced manifest is NOT trusted by the real verifier: ${verdict.reason ?? 'unknown'}`,
      },
    ];
  }
  return [];
}

/** The disk-backed produced-artifact IO over `apps/web/dist`. */
export function diskArtifactIO(): ProducedArtifactIO {
  return {
    bundleBytes: () => {
      if (!existsSync(DIST_ASSETS)) return undefined;
      const matches = readdirSync(DIST_ASSETS).filter(
        (f) => f.startsWith(`${ARTIFACT_ID}-`) && f.endsWith('.js'),
      );
      if (matches.length !== 1) return undefined;
      return new Uint8Array(readFileSync(join(DIST_ASSETS, matches[0] as string)));
    },
    manifest: () => {
      if (!existsSync(MANIFEST_FILE)) return undefined;
      try {
        return JSON.parse(readFileSync(MANIFEST_FILE, 'utf-8'));
      } catch {
        return undefined;
      }
    },
    keys: () => {
      if (!existsSync(KEYS_FILE)) return undefined;
      try {
        return JSON.parse(readFileSync(KEYS_FILE, 'utf-8')) as KeysSidecar;
      } catch {
        return undefined;
      }
    },
  };
}

async function main(): Promise<void> {
  const violations = runUpdateChannelGate(readFromDisk);

  // Post-build, the produced manifest is MANDATORY and must verify with the real
  // verifier (forged/missing ⇒ the gate bites).  The lint job (no dist) skips
  // this and runs the structural-wiring half only.
  if (existsSync(DIST)) {
    violations.push(...(await verifyProducedManifest(diskArtifactIO())));
  }

  if (violations.length > 0) {
    console.error('check:update-channel FAILED:');
    for (const v of violations) console.error(`  - ${v.file} — ${v.detail}`);
    process.exit(1);
  }
  const verified = existsSync(DIST) ? ' + produced manifest cryptographically verified' : '';
  console.log(
    `check:update-channel: OK (verify signature + transparency log before activation${verified})`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
