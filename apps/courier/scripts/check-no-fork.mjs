// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4a — "a hash check forbids a courier-only fork."  The native courier MUST
// be the SAME PWA in a shell, never a divergent copy of the web app.  This gate
// enforces that two ways:
//
//   (default)   structural — apps/courier carries NO web application source of its
//               own (no src/ app code, no own index.html / public / dist).  Its
//               `webDir` points at the canonical web build, so there is nothing to
//               fork.  Also asserts the web build (apps/web/dist) is present.
//
//   (--assets)  byte-identical — after `cap sync`, every file in apps/web/dist is
//               present BYTE-FOR-BYTE in the synced WebView assets
//               (android/app/src/main/assets/public).  The only files allowed to
//               exist there beyond the web build are the known Capacitor bridge
//               shims; anything else (an added/edited/removed app file) fails closed.
//
// Run by `pnpm --filter courier build` before and after the sync, and by the
// native-build CI job.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COURIER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIST = resolve(COURIER_DIR, '..', 'web', 'dist');
const SYNCED_ASSETS = resolve(COURIER_DIR, 'android', 'app', 'src', 'main', 'assets', 'public');

// Files Capacitor injects into the WebView assets beyond the web build (the bridge
// shims).  These are the ONLY additions tolerated; they are not web-app source.
const CAPACITOR_BRIDGE_FILES = new Set(['cordova.js', 'cordova_plugins.js']);

// A courier-local web app (any of these) would be a fork — the courier must have none.
const FORBIDDEN_FORK_PATHS = ['src', 'public', 'dist', 'index.html', 'www'];

function fail(msg) {
  console.error(`check-no-fork FAILED: ${msg}`);
  process.exit(1);
}

function walk(root) {
  const out = [];
  const recur = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) recur(full);
      else if (entry.isFile()) out.push(relative(root, full));
    }
  };
  recur(root);
  return out.sort();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function checkStructural() {
  // The courier must not ship a web app of its own — only config + scripts + the
  // generated android/ shell.  `webDir` (capacitor.config.json) points at ../web/dist.
  for (const forbidden of FORBIDDEN_FORK_PATHS) {
    if (exists(join(COURIER_DIR, forbidden))) {
      fail(
        `apps/courier/${forbidden} exists — the courier must carry no web-app source ` +
          `(it loads the unchanged apps/web/dist via webDir, never a courier-local copy).`,
      );
    }
  }
  if (!exists(WEB_DIST) || !exists(join(WEB_DIST, 'index.html'))) {
    fail(`apps/web/dist is missing — run \`pnpm --filter web build\` before the courier build.`);
  }
  console.log(
    'check-no-fork (structural): OK — courier carries no web-app source; web build present.',
  );
}

function checkAssetsByteIdentical() {
  if (!exists(SYNCED_ASSETS)) {
    fail(`synced assets missing at ${SYNCED_ASSETS} — run \`cap sync android\` first.`);
  }
  const webFiles = walk(WEB_DIST);
  const syncedFiles = new Set(walk(SYNCED_ASSETS));

  // Every web-build file must be present byte-for-byte in the WebView assets.
  for (const rel of webFiles) {
    if (!syncedFiles.has(rel))
      fail(`web build file missing from the courier WebView assets: ${rel}`);
    const webHash = sha256(join(WEB_DIST, rel));
    const syncedHash = sha256(join(SYNCED_ASSETS, rel));
    if (webHash !== syncedHash) {
      fail(
        `courier-only fork detected: ${rel} differs from apps/web/dist (the WebView must load the byte-identical web build).`,
      );
    }
  }

  // The WebView assets may carry ONLY the web build + the known Capacitor bridge shims.
  const webFileSet = new Set(webFiles);
  for (const rel of syncedFiles) {
    if (webFileSet.has(rel)) continue;
    if (CAPACITOR_BRIDGE_FILES.has(rel)) continue;
    fail(
      `unexpected file in the courier WebView assets (not in the web build, not a known bridge shim): ${rel}`,
    );
  }

  console.log(
    `check-no-fork (assets): OK — all ${webFiles.length} web-build files are byte-identical in the courier WebView; only the Capacitor bridge shims are added.`,
  );
}

if (process.argv.includes('--assets')) checkAssetsByteIdentical();
else checkStructural();
