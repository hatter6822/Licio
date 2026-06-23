// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.1 — `gen:update-manifest`: the build-time PRODUCER of the signed
// code-transparency update manifest (PRIVATE_SPEC §1, §3.2, §20.6, §22.4;
// WS-O.3.2b).  Run AFTER `pnpm --filter web build`.  It:
//
//   1. locates the built private-mode chunk in `apps/web/dist`
//      (`assets/private-p2p-<hash>.js`) and hashes its EXACT bytes — the same
//      SHA-256 the client's `bundle-digest.ts` computes over the served chunk;
//   2. resolves the maintainer release SIGNER + transparency-log keys: in
//      production from the BUILD-SECRET env group (`LICIO_UPDATE_SIGNING_KEY` +
//      `LICIO_UPDATE_LOG_KEY`, base64url PKCS#8 Ed25519 — never `VITE_`-prefixed,
//      so no secret reaches the client bundle); in dev/CI a generated fixture
//      keypair persisted under a GITIGNORED dev path is reused across runs;
//   3. APPENDS the bundle's domain-separated leaf to an append-only RFC-9162
//      transparency log (a local JSON Merkle-log file for dev/CI; a standalone
//      witnessed log SERVICE in production — see the prod-ops boundary note);
//   4. builds + Ed25519-SIGNS the manifest (the audited `produceSignedManifest`)
//      and emits `apps/web/dist/update-manifest.json` (the path the client
//      fetches) PLUS a public-keys sidecar (`update-channel-keys.json`) the gate
//      and the `VITE_PRIVATE_BUNDLE_*` env pin against.
//
// The signing key is a BUILD SECRET; only the manifest + the PUBLIC keys are
// emitted.  Reuses the audited WebCrypto Ed25519 (`crypto.subtle`) and the
// shared producer — no hand-rolled crypto.  Fail-closed: a missing chunk, an
// unreadable key, or a write failure aborts with a non-zero exit.
//
// PROD-OPS BOUNDARY.  The local append-only JSON log here is the Tier-1
// substrate so dev/CI produce a REAL signed+logged manifest the verifier
// accepts end-to-end.  A production deployment runs the transparency log as a
// standalone, append-only, WITNESSED service (RFC 9162 STH issuance + gossip)
// with the log signing key in dedicated custody; the build then calls that
// service to append the leaf and fetch the inclusion proof + signed checkpoint
// instead of mutating a repo file.  The manifest SHAPE the client verifies is
// identical either way — only the leaf-append + proof-fetch transport differs.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  emptyLog,
  type ManifestSigner,
  produceSignedManifest,
  type TransparencyLogState,
  type UpdateManifest,
} from '../packages/shared/dist/update/producer.js';

const ROOT = resolve(import.meta.dirname, '..');
const DIST_ASSETS = join(ROOT, 'apps', 'web', 'dist', 'assets');
const MANIFEST_OUT = join(ROOT, 'apps', 'web', 'dist', 'update-manifest.json');
const KEYS_OUT = join(ROOT, 'apps', 'web', 'dist', 'update-channel-keys.json');
const DEV_KEY_DIR = join(ROOT, '.licio-update-keys');
const DEV_KEY_FILE = join(DEV_KEY_DIR, 'dev-keys.json');
const LOG_DIR = join(ROOT, '.licio-update-log');
const ARTIFACT_ID = 'private-p2p';
const LOG_ID = 'licio-code-transparency';

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

/** A maintainer/log Ed25519 keypair (PKCS#8 private + raw public, both base64url). */
interface KeyPairB64 {
  readonly privatePkcs8: string;
  readonly publicRaw: string;
}
interface DevKeys {
  readonly signer: KeyPairB64;
  readonly log: KeyPairB64;
}

async function generateKeyPair(): Promise<KeyPairB64> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privatePkcs8: toBase64Url(pkcs8), publicRaw: toBase64Url(raw) };
}

/** Import a PKCS#8 private key for Ed25519 signing. */
async function importSigningKey(privatePkcs8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    fromBase64Url(privatePkcs8).slice().buffer,
    'Ed25519',
    false,
    ['sign'],
  );
}

/**
 * Resolve the signer + log keys.  Production: the BUILD-SECRET env group
 * (all-or-none).  Dev/CI: a generated fixture persisted under the gitignored
 * `.licio-update-keys/` so repeated builds reuse the same signer (a stable
 * `update-channel-keys.json` the local preview/E2E can pin).
 */
async function resolveKeys(): Promise<DevKeys & { readonly source: 'env' | 'dev' }> {
  const envSigner = process.env['LICIO_UPDATE_SIGNING_KEY'];
  const envSignerPub = process.env['LICIO_UPDATE_SIGNING_PUBLIC'];
  const envLog = process.env['LICIO_UPDATE_LOG_KEY'];
  const envLogPub = process.env['LICIO_UPDATE_LOG_PUBLIC'];
  const anyEnv = envSigner || envSignerPub || envLog || envLogPub;
  if (anyEnv) {
    if (!envSigner || !envSignerPub || !envLog || !envLogPub) {
      throw new Error(
        'incomplete update-signing env: set ALL of LICIO_UPDATE_SIGNING_KEY, ' +
          'LICIO_UPDATE_SIGNING_PUBLIC, LICIO_UPDATE_LOG_KEY, LICIO_UPDATE_LOG_PUBLIC ' +
          '(base64url PKCS#8 private + raw public) or NONE (dev fixture).',
      );
    }
    return {
      source: 'env',
      signer: { privatePkcs8: envSigner, publicRaw: envSignerPub },
      log: { privatePkcs8: envLog, publicRaw: envLogPub },
    };
  }
  // Dev/CI fixture: reuse a persisted keypair so the manifest is stable.
  if (existsSync(DEV_KEY_FILE)) {
    const parsed = JSON.parse(readFileSync(DEV_KEY_FILE, 'utf-8')) as DevKeys;
    return { source: 'dev', ...parsed };
  }
  const keys: DevKeys = { signer: await generateKeyPair(), log: await generateKeyPair() };
  mkdirSync(DEV_KEY_DIR, { recursive: true });
  writeFileSync(DEV_KEY_FILE, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  return { source: 'dev', ...keys };
}

/** Load (or start) the append-only transparency log file for `LOG_ID`. */
function loadLog(): TransparencyLogState {
  const file = join(LOG_DIR, `${LOG_ID}.json`);
  if (!existsSync(file)) return emptyLog(LOG_ID);
  const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
    logId: string;
    leafHashes: string[];
  };
  return {
    logId: parsed.logId,
    leafHashes: parsed.leafHashes.map((h) => fromBase64Url(h)),
  };
}

/** Persist the GROWN append-only log (write-only growth; never truncates). */
function saveLog(state: TransparencyLogState): void {
  mkdirSync(LOG_DIR, { recursive: true });
  const serialized = {
    logId: state.logId,
    leafHashes: state.leafHashes.map((h) => toBase64Url(h)),
  };
  writeFileSync(join(LOG_DIR, `${LOG_ID}.json`), `${JSON.stringify(serialized, null, 2)}\n`);
}

/** Find the built private-mode chunk bytes in `apps/web/dist/assets`. */
function readBundleBytes(): Uint8Array {
  if (!existsSync(DIST_ASSETS)) {
    throw new Error(
      `dist assets not found at ${DIST_ASSETS} — run \`pnpm --filter web build\` first`,
    );
  }
  const matches = readdirSync(DIST_ASSETS).filter(
    (f) => f.startsWith(`${ARTIFACT_ID}-`) && f.endsWith('.js'),
  );
  if (matches.length === 0) {
    throw new Error(`no built ${ARTIFACT_ID}-*.js chunk in ${DIST_ASSETS}`);
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous ${ARTIFACT_ID} chunk: ${matches.join(', ')}`);
  }
  return new Uint8Array(readFileSync(join(DIST_ASSETS, matches[0] as string)));
}

function appVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
    version?: string;
  };
  return pkg.version ?? '0.0.0';
}

/**
 * Monotonic release sequence: a build-pinned `LICIO_UPDATE_RELEASE_SEQUENCE`
 * (CI release counter) when set; otherwise the current append-only log size + 1
 * (each new leaf is a higher sequence — never a rollback in the local substrate).
 */
function releaseSequence(log: TransparencyLogState): number {
  const env = process.env['LICIO_UPDATE_RELEASE_SEQUENCE'];
  if (env !== undefined) {
    const n = Number.parseInt(env, 10);
    if (!Number.isInteger(n) || n < 0)
      throw new Error('LICIO_UPDATE_RELEASE_SEQUENCE must be a non-negative integer');
    return n;
  }
  return log.leafHashes.length + 1;
}

async function main(): Promise<void> {
  const bundleBytes = readBundleBytes();
  const keys = await resolveKeys();
  const log = loadLog();

  const signerPriv = await importSigningKey(keys.signer.privatePkcs8);
  const logPriv = await importSigningKey(keys.log.privatePkcs8);
  const signer: ManifestSigner = {
    signerPublicKeyB64: keys.signer.publicRaw,
    signManifest: async (m) =>
      new Uint8Array(await crypto.subtle.sign('Ed25519', signerPriv, m.slice().buffer)),
    signCheckpoint: async (m) =>
      new Uint8Array(await crypto.subtle.sign('Ed25519', logPriv, m.slice().buffer)),
    toBase64Url,
  };

  const produced = await produceSignedManifest({
    bundleBytes,
    log,
    release: {
      bundleVersion: appVersion(),
      releaseSequence: releaseSequence(log),
      artifactId: ARTIFACT_ID,
    },
    signer,
  });

  // Persist the GROWN log + emit the manifest + the PUBLIC-keys sidecar.
  saveLog(produced.log);
  writeManifest(produced.manifest);
  writeFileSync(
    KEYS_OUT,
    `${JSON.stringify(
      {
        // Public keys ONLY — the build pins these into VITE_PRIVATE_BUNDLE_*.
        signerPublicKeys: [keys.signer.publicRaw],
        logPublicKey: keys.log.publicRaw,
        artifactId: ARTIFACT_ID,
        logId: LOG_ID,
      },
      null,
      2,
    )}\n`,
  );

  // Console summary (NO secret material).
  console.log('gen:update-manifest: OK');
  console.log(
    `  key source       : ${keys.source}${keys.source === 'dev' ? ` (${DEV_KEY_FILE})` : ''}`,
  );
  console.log(`  bundle digest    : ${produced.bundleDigest}`);
  console.log(`  leaf index       : ${produced.leafIndex}`);
  console.log(`  release sequence : ${produced.manifest.body.release_sequence}`);
  console.log(`  manifest         : ${MANIFEST_OUT}`);
  console.log(`  signer (public)  : ${keys.signer.publicRaw}`);
  console.log(`  log key (public) : ${keys.log.publicRaw}`);
}

function writeManifest(manifest: UpdateManifest): void {
  writeFileSync(MANIFEST_OUT, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error('gen:update-manifest FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { main as buildUpdateManifest };
