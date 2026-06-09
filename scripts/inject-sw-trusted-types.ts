// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Prepend a Trusted Types `default` policy to the built service worker
// (WS-C.2.1d). The app ships `require-trusted-types-for 'script'`, under which
// `importScripts()` — how the Workbox runtime and the push handler are loaded —
// is a Trusted Types sink. Without a `default` policy the worker throws on load:
// it precaches nothing (no offline app shell) and cannot load the push handler.
//
// The policy vouchsafes SAME-ORIGIN script URLs ONLY (cross-origin still throws —
// defence in depth with `script-src 'self'`) and is safe in the worker, which has
// no DOM so its HTML/script sinks are inert. The `default` name is already
// permitted by the `trusted-types default dompurify` CSP directive. Runs in the
// web build chain right after `vite build`, before the SW security scan.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SW_PATH = resolve(import.meta.dirname, '..', 'apps', 'web', 'dist', 'sw.js');

/** The policy IIFE prepended to the worker (kept minimal; no eval/Function). */
export const TRUSTED_TYPES_POLICY =
  "(()=>{try{if(self.trustedTypes&&self.trustedTypes.createPolicy){self.trustedTypes.createPolicy('default',{createScriptURL:(u)=>{const p=new URL(u,self.location.href);if(p.origin!==self.location.origin)throw new TypeError('cross-origin script blocked');return u;},createHTML:(s)=>s,createScript:(s)=>s});}}catch(e){}})();\n";

/** Prepend the policy to the worker source unless it is already present. Pure. */
export function withTrustedTypesPolicy(source: string): string {
  return source.includes("createPolicy('default'") ? source : TRUSTED_TYPES_POLICY + source;
}

function main(): void {
  if (!existsSync(SW_PATH)) {
    console.error(`Service worker not found at ${SW_PATH} — run the build first.`);
    process.exit(1);
  }
  const source = readFileSync(SW_PATH, 'utf-8');
  const next = withTrustedTypesPolicy(source);
  if (next === source) {
    console.log('Service worker already carries the Trusted Types default policy.');
    return;
  }
  writeFileSync(SW_PATH, next);
  console.log('Prepended the Trusted Types default policy to the service worker.');
}

// Run as a script, but stay importable by the unit test.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}
