// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10 — the pure, browser-safe code-transparency update-channel CLIENT core
// (PRIVATE_SPEC §1, §3.2, §20.6, §22.4; WS-O.3.2b/3.2e).  The signed
// update-manifest schema + the fail-closed `verifyUpdateManifest` /
// `decideUpdateActivation` verdict + the RFC 9162 inclusion check + the WebCrypto
// primitives + the §20.6 lock copy.  No I/O, no app/db/lcap/private-p2p imports
// (this is a LEAF-package surface) — the client glue in `apps/web/src/update`
// feeds it the running bundle digest and the trusted signer set.
//
// The PRODUCER (`log.ts` + `produce.ts`) is DELIBERATELY NOT re-exported here:
// this barrel is reachable from the `@licio/shared` root index that the CLIENT
// imports, and the manifest-producing code is build-tool-only (it would needlessly
// ship to the client bundle).  Build tooling imports it from `./producer.js`.

export * from './copy.js';
export {
  ED25519_PUBLIC_KEY_LENGTH,
  ED25519_SIGNATURE_LENGTH,
  fromBase64Url,
  sha256Concat,
  verifyEd25519,
} from './crypto.js';
export { bytesEqual, leafHash, nodeHash, verifyInclusion } from './merkle.js';
export * from './schema.js';
export * from './verify.js';
