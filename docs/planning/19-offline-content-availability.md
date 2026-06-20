# WS-R: Offline Content Availability (LCAP v0.2)

**Milestone:** M3+ core resilience — **elevated to launch-relevant by maintainer decision (2026-06)**: the offline core *and* the native-courier and browser-P2P/WebTransport/IPFS transports are now first-class, in-scope v0.2 deliverables, not deferred extensions. | **Priority:** P1 (raised from P3) | **Dependencies:** WS-C (PWA shell, offline/IndexedDB, service worker), WS-D (account authority, device keys, sessions), WS-E (event/topic registry, attention doctrine), WS-F (stories/sources), WS-G (forum/rooms), WS-Q (room-owned content + visibility) — all complete | **Source spec:** `docs/OFFLINE_SPEC.md` (LCAP v0.2) | **Wave:** 8 (pulled earlier from Wave 10; parallelizable with WS-S after WS-R.0) | **Estimated duration:** 16-22 weeks (the elevated native courier + browser-P2P/WebTransport/IPFS transports add ~4-6 weeks over the transport-deferred baseline) | **Task count:** 99 atomic cards

---

## Overview

WS-R implements **LCAP v0.2 — the Licio Content Availability Protocol** (`docs/OFFLINE_SPEC.md`): a delay-tolerant, content-addressed, signed synchronization protocol that lets Licio content stay creatable, verifiable, transferable, and reconcilable under intermittent connectivity, hostile networks, cheap old phones, and incomplete trust. LCAP optimizes **useful verified availability per cost** (OFFLINE_SPEC §1), not raw bandwidth, and guarantees that tiny trust/liveness objects always move before media.

LCAP is organized as four planes (OFFLINE_SPEC §8):

    record plane     deterministic record bodies → record_cids; blocks → block_cids
    trust plane      detached proofs · device certs · capabilities · revocations · checkpoints · witnesses
    sync plane       pulse + exchange · anti-entropy · lane scheduler · liveness state machine · receipts
    transport plane  HTTPS · manual .licio-bundle · QR · local relay · WebTransport (HTTP/3) ·
                     WebRTC browser↔browser P2P · browser IPFS/libp2p (Helia) public-block bridge ·
                     native Android courier (Capacitor: Nearby Connections / Wi-Fi Direct / Bluetooth)

The baseline MUST work inside the existing PWA using HTTPS, service workers, IndexedDB, WebCrypto, and ordinary file import/export (OFFLINE_SPEC §3.1). Manual `.licio-bundle` transfer is a first-class transport, not a fallback. **Per the 2026-06 maintainer decision, the native radio courier (Capacitor: Nearby Connections / Wi-Fi Direct / Bluetooth) and the browser-to-browser P2P transports (WebTransport over HTTP/3, WebRTC data channels, and a browser IPFS/libp2p public-block bridge) are now first-class, in-scope v0.2 deliverables — fully implemented, decomposed, and gated, no longer "prototype-only" or "documentation-only" deferrals.** They remain **consent-gated and off by default** (transport reach is opt-in per operational mode, disabled in Stealth/Emergency), because elevating their *priority* never relaxes the doctrine: every promoted transport reuses the *same* packs, the single `validate(record_cid)`, the lane scheduler, and the trust pipeline (no parallel data model or trust path, OFFLINE_SPEC §22.5/§18.4), and **correctness never depends on any single transport** — HTTPS + manual bundle stay sufficient on their own (§22.6/§22.7).

LCAP is **almost entirely net-new code** in the new locations plus a new DB schema file; it touches the running app only at well-defined seams (service-worker hooks, a sibling IndexedDB database, the no-raw-egress/no-applause CI gates, reuse of WS-D account identity, and the WS-D account/room **authority signing keys** that WS-R provisions — see WS-R.1.1/1.2). It does **not** modify the WS-E attention pipeline, the WS-I ranking math, or any existing wire schema. The two elevated transport families add their own strictly-bounded seams: a **Capacitor native shell** (`apps/courier/`, a new native build + CI job that loads the *unchanged* web client and exposes radio P2P through a typed plugin) and a **code-split browser-P2P module** (`@licio/lcap-p2p`, a dedicated optional workspace package carrying the heavier WebRTC/Helia dependencies so they never enter the initial bundle and never count against the `apps/web` `<15` direct-production-dependency budget — see "Dependency posture" below).

### New and touched modules (verified against the shipped tree)

| Concern | Module / file | WS-R change |
|---|---|---|
| Pure protocol library | `packages/lcap/` (new) | deterministic CBOR (LDC), CID, COSE detached proof, zod schemas, validate/trust projection, streaming pack, lane scheduler, sync state machine, test vectors (OFFLINE_SPEC §31) |
| Web integration | `apps/web/src/lcap/` (new) | `lcap_v2` IndexedDB, outbox/signing, pulse/exchange/fetch orchestration, streaming bundle export/import, trust/liveness badges, storage policy |
| Server integration | `apps/api/src/lcap/` (new) | Hono `/api/lcap/v2/*` routes, pack ingestion, proof/capability/revocation verify, room-log reconcile, Merkle checkpoints, receipt emission |
| Database | `packages/db/src/schema/lcap.ts` (new) + migrations | `lcap_records`, `lcap_proofs`, `lcap_blocks`, `lcap_chunks`, `lcap_device_certs`, `lcap_capabilities`, `lcap_capability_usage`, `lcap_revocations`, `lcap_room_log`, `lcap_room_checkpoints`, `lcap_receipts`, `lcap_quarantine`, `lcap_fork_evidence` (OFFLINE_SPEC §30) |
| Local-DB coexistence | `apps/web/src/offline/db.ts` (`DB_NAME = 'licio'`) | none — LCAP uses a separate `lcap_v2` database (OFFLINE_SPEC §23.1); no migration of WS-C stores |
| Device identity | WS-D `webauthn-credential` / `wallet-auth-credential` / account model + a **new server authority signing key** | the account *model* (`account_id`) is reused read-only, but WS-D ships **no** server-held asymmetric signing key (only HKDF hashing, AES-GCM, HMAC-SigV4, and push-scoped VAPID), so WS-R **provisions** the `licio_account_authority` and `RoomAuthority` ES256 signing keys (generation, SecretBox encrypt-at-rest, an `*_AUTHORITY_*` env group mirroring `SES_*`/VAPID, `account_epoch` rotation) that sign `device_certificate` / `room_capability` records; LCAP device keys are new, room-scoped, non-extractable signing keys (OFFLINE_SPEC §10.5, §11 — see WS-R.1.1/1.2) |
| Service worker | `apps/web/public/sw-push.js` + `sw-register.ts` | add C0-first sync-on-connectivity hook; no remote `importScripts`; respects data/battery/privacy mode (OFFLINE_SPEC §23.3); `check:sw` stays green |
| Crypto / compression primitives | WebCrypto `crypto.subtle`, Compression Streams | SHA-256 + ES256 + AES-256-GCM from the platform; gzip/deflate from the platform — **the LCAP core (`packages/lcap`) keeps zero runtime npm dependencies** (OFFLINE_SPEC §31.1) |
| Native courier shell | `apps/courier/` (new Capacitor project) + `@capacitor/*` + a typed Nearby-Connections/Wi-Fi-Direct plugin | wraps the **unchanged** web client in a Capacitor Android shell; a typed native plugin streams the *same* packs over Nearby Connections / Wi-Fi Direct / Bluetooth / local hotspot / USB; a new native build + CI job; Capacitor/native deps are **build/native-scoped**, not `apps/web` web-production deps (WS-R.15.4a–f) |
| Browser P2P transport | `@licio/lcap-p2p/` (new optional workspace package) consumed by a **code-split** `apps/web/src/lcap/transports/` chunk | carries the heavier WebRTC + Helia/js-libp2p deps **behind a workspace boundary** so they never enter the initial bundle (200 KB gz gate holds) and never count against the `apps/web` `<15` direct-production-dep budget; WebTransport uses the platform API (no dep); all three reuse the pack/validation/scheduler/trust pipeline (WS-R.15.5–15.9) |
| Privacy gates | `check:no-raw-egress`, `check:no-applause`, `check:lcap-schema-egress` | extended to scan `packages/lcap`, `@licio/lcap-p2p`, `apps/web/src/lcap`, `apps/api/src/lcap`, and `apps/courier` source; assert no transport-layer IP / radio / multiaddr / peer identifier ever appears in an LCAP **schema** (it lives only at the live-connection layer) (OFFLINE_SPEC §3.7, §26.4) |
| Private-room bridge | `docs/PRIVATE_SPEC.md` (WS-S) | LCAP carries only ciphertext + opaque room hints for `private_p2p` rooms; the `.licio-bundle` pack MAY serve as WS-S's encrypted CAR (OFFLINE_SPEC §28.1) |

### Relationship to other specs and workstreams

- **WS-S / `docs/PRIVATE_SPEC.md`** — LCAP is the *availability and transport* substrate; WS-S owns the *authority and confidentiality* plane for E2EE private rooms. They compose: WS-S MAY reuse the LCAP pack, lane scheduler, and liveness labelling for ciphertext, but LCAP never sees private plaintext, keys, op heads, or real private room IDs. The two planes pin different suites on purpose (ES256 here; Ed25519/MLS in WS-S) and never share keys.
- **Doctrine.** LCAP schemas carry no attention traces, no client IP/location, and no like/vote/karma/reaction fields anywhere (OFFLINE_SPEC §3.7); the existing `check:no-raw-egress`/`check:no-applause` gates are extended to LCAP source.
- **Identity (WS-D).** The Licio account authority is the issuer of `device_certificate` records; LCAP adds new device signing keys and capabilities but invents no new account model.
- **Content (WS-F/WS-G/WS-Q).** A `contribution_event` record mirrors the WS-G contribution taxonomy and the WS-Q room/visibility model; an accepted LCAP record reconciles into the same canonical room/thread state the server already maintains — LCAP is an alternate ingress/egress, never a parallel truth.

### Conventions for this workstream

- **Determinism is pinned by vectors.** LDC encoding (OFFLINE_SPEC §9.1), CID construction (§9.2), COSE `Sig_structure` (§10.2), and Merkle hashing (§19.1.1) are normatively pinned by `packages/lcap/src/test-vectors/`; any change that alters a published vector is breaking and bumps the profile version.
- **`record_cid` excludes proof bytes (ABSOLUTE).** Record identity is the hash of the deterministic body only; signatures are detached proofs (§5.1). A property test enforces it.
- **No transport trust (ABSOLUTE).** A record from a trusted friend and a record from a hostile relay traverse the identical validation pipeline (§18.4); human trust may gate import willingness but never bypasses cryptographic/policy validation.
- **Fail-closed everywhere.** Unknown critical fields, unknown algorithms, undecodable framing, missing dependencies, and unreadable trust state all fail closed (§9.1.4, §10.3, §27); nothing renders as trusted before trust projection (§18).
- **C0 cannot starve.** The lane scheduler's byte reservation guarantees control/liveness traffic moves first in every budget (§15); a named starvation test gates CI.
- **Hard pins are never GC'd.** The local outbox, drafts, own proofs, active cert/capability, and fresh revocations are hard-pinned and survive normal eviction (§20.5, §21.2).
- **Dependency posture: zero-dep core, isolated optional-transport deps (ABSOLUTE).** The **LCAP core** (`packages/lcap`) uses only WebCrypto + Compression Streams + IndexedDB and carries **zero** runtime npm dependencies — the deterministic-CBOR/COSE subset is hand-rolled (§31.1). The web LCAP module (`apps/web/src/lcap`) is code-split so the initial-load bundle-size gate (< 200 KB gz) does not regress, and `apps/web` MUST NOT import `@licio/db`. The **elevated optional transports** introduce reviewed dependencies that are structurally prevented from regressing either budget: the browser WebRTC/IPFS stack (Helia/js-libp2p) lives in a dedicated optional workspace package `@licio/lcap-p2p` (`workspace:*`, excluded from the `apps/web` `<15` direct-production-dep count) loaded only from a **separately code-split** `apps/web/src/lcap/transports/` chunk (never in the initial bundle); the native courier's `@capacitor/*` deps live in the `apps/courier` native-shell project (build/native scope, not a web production dep); WebTransport uses the platform API (no dependency). Every such dependency passes the Section 6.12.12 dependency-addition checklist (no install scripts, AGPL-compatible license, transitive count reviewed, SBOM updated) — see "Dependency posture" under WS-R.15.
- **Transport priority never relaxes doctrine (ABSOLUTE).** Elevating a transport's *priority* changes only its scheduling and decomposition, never its trust or privacy posture: (a) every transport reuses the *same* packs, the single `validate(record_cid)`, the lane scheduler, and the trust pipeline — **no parallel data model or trust path** (§22.5, §18.4); (b) **correctness never depends on any single transport** — HTTPS + manual bundle remain sufficient alone, and every P2P/courier path has a documented fallback (§22.6/§22.7); (c) transport reach is **opt-in per operational mode, off by default, and disabled in Stealth/Emergency** (§33); (d) the IPFS bridge publishes **public blocks only**, behind a required privacy/moderation/abuse-review gate (§22.7).
- **Transport-layer metadata is never an LCAP schema field (ABSOLUTE).** WebRTC ICE/STUN/TURN peer IPs, libp2p multiaddrs, and Nearby/Wi-Fi-Direct/Bluetooth radio identifiers are inherent to those *live connections* (exactly as the IP behind any HTTPS request is) but MUST NOT appear in any LCAP record/proof/receipt/log schema. They are disclosed in the transport's privacy warning, kept at the connection layer only, and asserted out of the schema surface by `check:lcap-schema-egress` (extended to the P2P/courier source).
- **Doctrine gates extended.** `check:no-raw-egress` and `check:no-applause` are extended to the new LCAP source trees (incl. `@licio/lcap-p2p` and `apps/courier`); a new `check:lcap-schema-egress` asserts no IP/location/attention/multiaddr/radio-identifier field name appears in any LCAP record/proof/receipt schema.
- **UI honesty (§34).** Trust and liveness are never collapsed into a single "verified"/"delivered" badge; the UI exposes provisional/stale/conflict/revoked/rejected states explicitly and avoids the words *secure/trusted/delivered/final/safe* unless the exact meaning is shown.
- **Task sizing (Section 30.8).** Every card is one deliverable — one schema, one codec, one verifier, one endpoint, one store, one client state — reviewable, testable, and reversible in ≤ 1-3 engineering days. Sub-area headers group cards; the dependency graph at the end fixes their order.

---

## WS-R.0 Foundations: deterministic encoding, CIDs, and the crypto profile

### WS-R.0.1 `packages/lcap` package scaffold
**ID:** WS-R.0.1 | **Ref:** OFFLINE_SPEC §31, §31.1

**Description:** Create the `@licio/lcap` workspace at `packages/lcap/` with the §31 source tree (`cbor/`, `cid/`, `cose/`, `schemas/`, `validate/`, `pack/`, `scheduler/`, `sync/`, `test-vectors/`), TypeScript strict config (`types: ["node"]`), a thin `vitest.config.ts` reusing `vitest.shared.ts`, and an SPDX header on every file. The package depends on `@licio/shared` only; it MUST NOT depend on `@licio/db`. Declare zero runtime npm dependencies — SHA-256/ECDSA/AES come from WebCrypto, compression from Compression Streams (§31.1). **Register the new workspace in `scripts/check-workspace-deps.ts`** — add `@licio/lcap` to `ALLOWED_WORKSPACE_DEPS` (value `['@licio/shared']`), `WORKSPACE_PACKAGES`, `PACKAGE_PATHS`, and `SOURCE_DIRS`; the gate hard-codes its package list, so without this a forbidden `@licio/db` import inside `packages/lcap` would be invisible while `check:workspace-deps` still passes.

**Acceptance criteria:**
- `pnpm --filter @licio/lcap build` and `pnpm --filter @licio/lcap test` run standalone.
- `scripts/check-workspace-deps.ts` includes `@licio/lcap` in all four maps; a deliberately-added `@licio/db` import in a `packages/lcap` fixture makes `pnpm check:workspace-deps` FAIL (the gate actually scans the package), and the legitimate `@licio/shared`-only graph passes.
- `pnpm check:deps` unaffected (web/api budgets unchanged); the package is excluded from the web direct-dep count.

**Testing:** Unit — a trivial export smoke test. CI — workspace-boundary and dep-budget gates green.

**Dependencies:** none (new leaf-ish package; depends on `@licio/shared`).

---

### WS-R.0.2a LDC encoder
**ID:** WS-R.0.2a | **Ref:** OFFLINE_SPEC §9.1.1, §9.1.2, §9.1.3

**Description:** Implement `packages/lcap/src/cbor/encode.ts`: `encode(value: LdcValue): Uint8Array` over the closed LDC grammar. Per major type: **uint (0)** / **nint (1)** use the shortest argument form — inline for `0..23`, then 1/2/4/8-byte forms at the exact thresholds `24`, `256`, `65536`, `2^32` (a table-driven `writeArgument(major, n)`); **bstr (2)** / **tstr (3)** are definite-length, length prefixed by the same shortest-argument rule, text validated as UTF-8 and, in identifier positions, NFC (WS-R.0.2c flags the position set); **array (4)** / **map (5)** are definite-length; **map keys are sorted by the bytewise-lexicographic order of their *encoded* key bytes** — encode every key, sort `(encodedKey, encodedValue)` pairs by `encodedKey`, then concatenate (RFC 8949 §4.2.1); **simple (7)** emits only `false`(0xf4)/`true`(0xf5)/`null`(0xf6). Optional fields are omitted by the caller (the schema layer), never encoded as `null`. The encoder MUST refuse to emit floats, tags, `undefined`, indefinite lengths, or BigInt outside the representable integer range. Hand-rolled — no CBOR dependency (§31.1).

**Acceptance criteria:**
- The integer boundary set `{0, 23, 24, 255, 256, 65535, 65536, 2^32−1, 2^32, −1, −24, −256}` each encodes to the documented shortest byte sequence (pinned in the §9.1.5 table).
- Map output is independent of input insertion order (keys re-sorted by encoded-key bytes); empty `bstr`/`tstr`/array/map encode to the canonical one-byte head.
- Attempting to encode a float/tag/`undefined`/out-of-range integer throws `LdcEncodeError` with the offending path.

**Testing:** Unit — per-major-type byte assertions; integer-boundary table; insertion-order-independence of maps; reject-float/tag/undefined.

**Dependencies:** WS-R.0.1.

---

### WS-R.0.2b LDC strict decoder
**ID:** WS-R.0.2b | **Ref:** OFFLINE_SPEC §9.1.1, §9.1.4, §27.1

**Description:** Implement `packages/lcap/src/cbor/decode.ts`: `decode(bytes, { maxDepth, maxBytes }): LdcValue` as a bounded recursive-descent parser that **rejects (never normalizes) any non-canonical input** with a typed `LdcDecodeError(reason, offset)`. Rejections: additional-info `28..30` (reserved) and `31` (indefinite); a non-shortest argument (e.g. `0x18 0x05` for the value 5); major type 6 (tags); major type 7 anything other than `0xf4/0xf5/0xf6` (so all floats and other simple values fail); a map whose successive encoded keys are not **strictly** increasing in bytewise-lexicographic order (catches both duplicates and mis-ordering in one check); invalid UTF-8; and, in identifier positions, non-NFC text. The parser enforces the §27.1 resource caps (`maxDepth`, `maxBytes`, total item budget) and rejects trailing bytes after the top-level item. `decode` is total over its bounded input.

**Acceptance criteria:**
- Each non-canonical fixture — indefinite length, non-shortest int, tag, float, out-of-order key, duplicate key, invalid UTF-8, trailing bytes, over-depth — yields the correct `LdcDecodeError.reason` and byte `offset`.
- `decode(encode(v))` is structurally identical to `v`; `encode(decode(b))` is byte-identical to canonical `b`.
- A depth/size-bomb input aborts at the cap, not by exhausting memory.

**Testing:** Unit — the full rejection matrix with offset assertions; round-trip with the encoder; depth/size-cap abort.

**Dependencies:** WS-R.0.2a.

---

### WS-R.0.2c LDC conformance vectors + determinism property suite
**ID:** WS-R.0.2c | **Ref:** OFFLINE_SPEC §9.1.5, §32.1, §32.2

**Description:** Commit the normative `packages/lcap/src/test-vectors/cbor.json` corpus (one entry per record/proof shape and per edge case: logical value → canonical hex) and the determinism property suite: **(P1)** equal logical value ⇒ identical bytes across runs and across the browser and Node runtimes; **(P2)** `decode∘encode = id` on values and `encode∘decode = id` on canonical bytes; **(P3)** every non-canonical fixture fails closed. Define the **identifier-position set** (the map keys and string fields that must be NFC — domain separators, ids, kinds, network) as data consumed by the encoder/decoder, so the NFC rule is enforced uniformly and tested. Any change that alters a published vector is breaking and bumps the LDC profile version.

**Acceptance criteria:**
- The corpus covers every record/proof body shape plus the integer-boundary and reject cases; CI replays it both directions in both runtimes.
- The identifier-position set is the single source for NFC enforcement; a non-NFC identifier fixture is rejected, a non-identifier free-text value is not (it lives in a block anyway, §9.1.2).
- Altering any vector fails CI until the profile version is bumped.

**Testing:** Unit/property — corpus replay (browser + Node); P1/P2/P3 properties via `fast-check`; vector-stability guard.

**Dependencies:** WS-R.0.2b.

---

### WS-R.0.3 CID construction (record/proof/block/chunk) + vectors
**ID:** WS-R.0.3 | **Ref:** OFFLINE_SPEC §9.2, §9.3, §9.4

**Description:** Implement `packages/lcap/src/cid/`: `cidFor(kind, bytes)` producing the §9.2 binary layout `0x01 || kind_code || 0x12 || 0x20 || sha256(bytes)` (kind_code: record `0x01`, proof `0x02`, block `0x03`, chunk `0x04`) and the string form `human_prefix || base32(cid_bytes)` (RFC 4648 §6 lower-case, no padding; prefixes `lcapr_`/`lcapp_`/`lcapb_`/`lcapc_`). Provide `parseCid` (validates prefix↔kind_code coherence, length, multihash bytes) and `verifyCid(cid, bytes)`. SHA-256 via `crypto.subtle.digest`.

**Acceptance criteria:**
- `record_cid` is computed over the deterministic record body only (never proof/framing/compression).
- `parseCid` rejects a string whose human prefix and binary `kind_code` disagree, wrong length, or non-`0x12/0x20` multihash.
- `test-vectors/cid.json` pins body→cid for each kind and is asserted.

**Testing:** Unit — construct/parse/verify/reject matrix; vector replay; cross-check that a record digest cannot be reparsed as a block CID.

**Dependencies:** WS-R.0.2a.

---

### WS-R.0.4 Domain separation + `external_aad` builder
**ID:** WS-R.0.4 | **Ref:** OFFLINE_SPEC §9.5, §10.2.2

**Description:** Implement `packages/lcap/src/cose/aad.ts`: `domainSeparator(network_id, object_kind, purpose)` producing the §9.5 grammar string (`LCAP-v0.2:<net>:<kind>:<purpose>`, validated against the allowed token sets) and `buildExternalAad({ separator, protocol_version, network_id, record_kind, proof_kind })` returning the LDC encoding of the fixed-shape array (§10.2.2). The separator is only ever carried as the first array element, never hand-concatenated with payload bytes.

**Acceptance criteria:**
- `buildExternalAad` output is byte-stable and equals a committed vector.
- Separator grammar rejects illegal `object_kind`/network tokens.
- A mismatched `network_id`/`record_kind`/`proof_kind` produces a different AAD (and therefore a non-verifying signature downstream).

**Testing:** Unit — grammar accept/reject; AAD byte-stability vector; differential test that any field change perturbs the bytes.

**Dependencies:** WS-R.0.2a.

---

### WS-R.0.5a ECDSA P-256 low-S sign/verify core
**ID:** WS-R.0.5a | **Ref:** OFFLINE_SPEC §10.1, §10.1.1

**Description:** Implement `packages/lcap/src/cose/ecdsa.ts` over WebCrypto `ECDSA {name:'ECDSA', hash:'SHA-256', namedCurve:'P-256'}`. Pin the group order `n = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551` and `n/2`. `signEs256(privKey, message): Uint8Array` calls `crypto.subtle.sign` (which already emits IEEE-P1363 raw `r||s`, 64 bytes), parses `r||s`, and **normalizes low-S** (`if s > n/2: s := n − s`), re-serializing 32-byte big-endian `r||s`. `verifyEs256(pubKey, message, sig): boolean` REJECTS before calling `crypto.subtle.verify`: a non-64-byte/DER-shaped input (`rejected_bad_signature`), `r == 0 || s == 0 || r >= n || s >= n` (out of range), and `s > n/2` (`rejected_high_s_signature`); only a canonical low-S `r||s` proceeds to cryptographic verification. The message is the already-hashed-by-WebCrypto input (SHA-256 applied internally).

**Acceptance criteria:**
- A signature is always emitted low-S; round-trip `verify(sign(m)) == true`.
- The rejection matrix is exact: high-S → `rejected_high_s_signature`; DER/length-wrong → `rejected_bad_signature`; `r`/`s` zero or `≥ n` → out-of-range rejection; only canonical low-S verifies.
- No code path accepts a DER-encoded signature on the wire.

**Testing:** Unit — sign-is-low-S property; the five-case rejection matrix; known-answer vectors for `r||s` boundaries (`s = n/2`, `s = n/2 + 1`).

**Dependencies:** WS-R.0.1.

---

### WS-R.0.5b Device key lifecycle + runtime adapter + interop vectors
**ID:** WS-R.0.5b | **Ref:** OFFLINE_SPEC §10.5, §32.5

**Description:** Implement `packages/lcap/src/cose/keys.ts`: `generateDeviceKey()` producing a **non-extractable** P-256 `CryptoKey` pair where the runtime supports it (`extractable:false`; `exportKey('jwk'|'raw')` of the private key rejects); `exportPublicKeyCose(pub)` / `importPublicKeyCose(bytes)` round-tripping the public key as a COSE_Key (EC2, P-256, `x`/`y`) for embedding in `device_certificate.public_key_cose`; and a tiny runtime adapter resolving `crypto.subtle` from `globalThis.crypto` (browser) or `node:crypto`'s `webcrypto` (Node) so `packages/lcap` stays runtime-agnostic. Commit the §32.5 interop vectors: a message + key where a signature produced under WebCrypto-in-browser verifies under Node and vice versa.

**Acceptance criteria:**
- A generated private key is non-extractable where supported; `exportKey` of it rejects; the public key round-trips through COSE_Key bytes.
- The same `packages/lcap` build runs unmodified in both runtimes via the adapter (no `node:` import leaks into a browser bundle).
- Browser↔Node interop vectors cross-verify in CI.

**Testing:** Unit — key gen + non-extractability; COSE_Key round-trip. Gated cross-runtime — interop vector replay (Node unit + Playwright/WebCrypto).

**Dependencies:** WS-R.0.5a.

---

### WS-R.0.6a COSE_Sign1 builder + detached signer
**ID:** WS-R.0.6a | **Ref:** OFFLINE_SPEC §10.2, §10.2.1, §10.2.3

**Description:** Implement `packages/lcap/src/cose/sign1.ts` `buildAndSign({ privKey, signer_key_id, proof_kind, record_kind, record_body, network_id })`: encode the protected header `cose_protected = LDC({1: -7})` (ES256; the algorithm lives ONLY in the protected header); build `external_aad` via WS-R.0.4; assemble `Sig_structure = ["Signature1", cose_protected, external_aad, deterministic_record_body]`; compute `ToBeSigned = LDC(Sig_structure)`; sign with WS-R.0.5a; and return a `DetachedProofV2` (`proof_version:2`, `proof_kind`, `record_cid` = `cidFor('record', record_body)`, `record_kind`, `cose_protected`, `external_aad`, `signature`, `signer_key_id`). The payload signed is the deterministic record body bytes (so any off-the-shelf COSE_Sign1 verifier interoperates), while `record_cid` binds the proof to a stable identity.

**Acceptance criteria:**
- The produced proof's `record_cid` equals `cidFor('record', record_body)`; the signed `ToBeSigned` matches the §10.2.3 layout byte-for-byte (pinned vector).
- The algorithm appears only in `cose_protected`; `cose_unprotected` (if present) is never part of `ToBeSigned`.
- The same body signed by two different device keys yields two proofs with distinct `proof_cid`s and the identical `record_cid` (multi-proof identity).

**Testing:** Unit — `ToBeSigned` byte layout vs vector; multi-proof identity; protected-header-only-alg assertion.

**Dependencies:** WS-R.0.3, WS-R.0.4, WS-R.0.5a.

---

### WS-R.0.6b COSE_Sign1 detached verifier + status mapping
**ID:** WS-R.0.6b | **Ref:** OFFLINE_SPEC §10.2.4, §10.3, §16.11

**Description:** Implement `verifyDetached(proof, record_body, { network_id, expected_record_kind }): { ok: true } | { ok: false, status }` executing the §10.2.4 six steps in order with exact `ObjectStatusV2` mapping: (1) recompute `record_cid'` and compare → `rejected_bad_cid`; (2) parse `cose_protected`, require a known, enabled, non-downgraded alg (via WS-R.0.8) → `rejected_bad_signature` on absent/unknown/disabled; (3) rebuild `external_aad` from local params and byte-compare → `rejected_bad_signature` on mismatch; (4) rebuild `Sig_structure`/`ToBeSigned`; (5) canonical low-S check → `rejected_high_s_signature`; (6) `verifyEs256` → `rejected_bad_signature` on failure. Returns `ok` only when all six pass.

**Acceptance criteria:**
- Each of the six failure modes returns its exact status code; a fully valid proof returns `ok:true`.
- Moving the alg to the unprotected header, or advertising a disabled suite, is rejected at step 2 (no downgrade, §10.3).
- `test-vectors/sign1.json` (body + key → proof, plus six tamper variants) is committed and replayed in CI in both runtimes.

**Testing:** Unit — six-step failure matrix with status assertions; downgrade rejection; vector replay (browser + Node).

**Dependencies:** WS-R.0.6a, WS-R.0.8.

---

### WS-R.0.7 Closed-schema zod records and proofs
**ID:** WS-R.0.7 | **Ref:** OFFLINE_SPEC §9.1.4, §10.2, §12.1

**Description:** In `packages/lcap/src/schemas/` define strict (`.strict()`) zod schemas for the §4.1 type aliases and every record/proof body (`DetachedProofV2`, `DeviceCertificateRecordV2`, `CapabilityRecordV2`, `RevocationRecordV2`, `ContributionEventRecordV2`, block/chunk descriptors). Unknown keys are rejected (`rejected_bad_schema`); forward compatibility is via `record_version` bump only. Each schema's parse is paired with LDC decode so wire bytes and the validated object cannot diverge.

**Acceptance criteria:**
- Every record/proof schema rejects unknown keys and missing required fields with a field-named error.
- `record_version`/`proof_version` mismatches route to the version-specific schema or reject.
- Schemas are the single normative source; the TypeScript sketches in the spec are illustrative.

**Testing:** Unit — accept/reject matrix per schema; unknown-field rejection; `expectTypeOf` inference checks.

**Dependencies:** WS-R.0.2b.

---

### WS-R.0.8 Algorithm agility + downgrade protection
**ID:** WS-R.0.8 | **Ref:** OFFLINE_SPEC §10.3, §10.4

**Description:** Centralize suite negotiation in `packages/lcap/src/cose/suites.ts`: a `CryptoSuiteId` registry (`ES256` enabled; `Ed25519` reserved/disabled) with a fail-closed resolver that rejects unknown algorithms and forbids accepting a weaker/disabled suite because a peer omitted the stronger one. Reserve COSE alg ids and schema space for a future classical+PQ hybrid proof over the same `record_cid` (§10.4) without changing record identity.

**Acceptance criteria:**
- An unknown or disabled alg fails closed unless the record is explicitly handled as an opaque untrusted object.
- A node supporting ES256 (+future Ed25519) never downgrades when a peer advertises fewer suites.
- The hybrid-proof reservation is documented and a schema placeholder exists; enabling it does not alter `record_cid`.

**Testing:** Unit — negotiation/downgrade matrix; reserved-id placeholder test.

**Dependencies:** WS-R.0.1. (Consumed by WS-R.0.6b; foundational registry, no COSE dependency.)

---

## WS-R.1 Identity, certificates, capabilities, and revocations

### WS-R.1.1 Device certificate record + authority proof
**ID:** WS-R.1.1 | **Ref:** OFFLINE_SPEC §11.1, §11.2

**Description:** Implement the `device_certificate` record (`account_id`, `device_id`, `device_key_id`, `public_key_cose`, validity window, `account_epoch`, flags) and its issuance: the Licio **account authority** (WS-D) signs an `authority_signature` proof binding the account to the new device key. The device generates its signing key locally (non-extractable where supported); the server never requires an exportable private key (§10.5).

**Acceptance criteria:**
- A device certificate is untrusted without a valid authority proof; the proof binds `account_id ↔ device_key_id`.
- Validity window and `account_epoch` are enforced at validation time.
- Device key generation is local; the cert/capability are revocable and replaceable on key loss.

**Testing:** Unit — cert build + authority-proof verify; expired/forged-proof rejection. Gated integration — authority issuance path.

**Dependencies:** WS-R.0.6a, WS-R.0.6b, WS-R.0.7.

---

### WS-R.1.2 Capability record + quotas + transfer policy
**ID:** WS-R.1.2 | **Ref:** OFFLINE_SPEC §11.3

**Description:** Implement the `room_capability` record: subject (account/device/key), `room_id`, `visibility_scope`, `operations: LcapOperation[]`, `policy_epoch`, `revocation_epoch_floor`, validity window, `quotas` (max offline events, total/single/media payload bytes, export count), and `transfer_policy` (may export bundle / share with relay / courier / unknown peer). High-risk rooms and moderation roles use short-lived capabilities; long-lived public-room posting capabilities carry strict quotas.

**Acceptance criteria:**
- Capability requires an authority proof; `operations`/`visibility_scope`/`room_id` gate the records it can authorize.
- Quotas and `transfer_policy` are represented and parse-validated; defaults are conservative.
- A capability validates only within its window and at/above its `revocation_epoch_floor`.

**Testing:** Unit — capability build/verify; quota/scope parse matrix; window enforcement.

**Dependencies:** WS-R.1.1.

---

### WS-R.1.3 Capability consumption + device-sequence chain
**ID:** WS-R.1.3 | **Ref:** OFFLINE_SPEC §11.4, §12.2

**Description:** Implement local capability-usage accounting and the per-device signing chain: `device_seq` is a single monotonic counter **per `device_key_id`, global across all capabilities/rooms** (§11.4); each signed contribution after the first references `prev_device_record_cid`. Quota is debited per `capability_cid` (event count / payload bytes), independent of the sequence. Expose `consumeCapability` (client, pre-sign check) with the server enforcing final usage independently.

**Acceptance criteria:**
- `device_seq` is global-per-device monotonic; the hash chain links via `prev_device_record_cid`.
- Quota debits attach to `capability_cid`, not to the sequence; interleaved capabilities are handled.
- Local consumption is advisory; the server is authoritative (WS-R.12.3).

**Testing:** Unit — sequence monotonicity, chain linkage, per-capability quota accounting; interleaved-capability case.

**Dependencies:** WS-R.1.2.

---

### WS-R.1.4 Revocation record + P0 scheduling
**ID:** WS-R.1.4 | **Ref:** OFFLINE_SPEC §11.5, §15.1.1

**Description:** Implement the `revocation` record (`revoked_kind ∈ device|capability|account|room_policy|proof`, `revoked_id`, scope, `effective_at_ms`, `revocation_epoch`, optional `reason_code`/`replacement_cid`). Revocations are P0/C0 control records scheduled before all non-control content (§15.2). Maintain a local revocation index keyed by scope+epoch for trust projection.

**Acceptance criteria:**
- A revocation marks its target revoked at the named epoch; trust projection (WS-R.8) consumes the index.
- Revocations are classed P0/C0 and cannot be starved by media (enforced in WS-R.5).
- `replacement_cid` (e.g. a new cert) is followed where present.

**Testing:** Unit — revocation parse + index update; epoch ordering; P0 classification assertion.

**Dependencies:** WS-R.0.7.

---

### WS-R.1.5 Identity-chain validation
**ID:** WS-R.1.5 | **Ref:** OFFLINE_SPEC §11.1, §18.3

**Description:** Implement `validateIdentityChain(record)` composing the §18.3 steps 6–11 over the proof DAG: load signer key + device certificate, verify the certificate authority proof, load the cited capability, verify its authority proof, check operation/scope/room/visibility/policy/quota, then check known revocations. Returns the discharged trust facts and any missing dependency CIDs.

**Acceptance criteria:**
- A contribution is authorized only if cert + capability validate against local knowledge and no revocation applies.
- Missing cert/capability/revocation data yields `quarantined_*` with the precise `missing_cids`, not a false accept.
- A revoked device/capability/account is reported revoked regardless of an otherwise-valid chain.

**Testing:** Unit — full-chain accept; each broken-link case (missing/expired/forged/revoked) with the right status + missing CIDs.

**Dependencies:** WS-R.1.1, WS-R.1.2, WS-R.1.3, WS-R.1.4, WS-R.0.6b.

---

## WS-R.2 Event records and the record graph

### WS-R.2.1 Contribution event record + WS-G/WS-Q mapping
**ID:** WS-R.2.1 | **Ref:** OFFLINE_SPEC §12.1; WS-G §15.2; WS-Q §14.5

**Description:** Implement the `contribution_event` record. Its `event_type` set and `licio_contribution_type` map onto the shipped WS-G eleven-type taxonomy. The record's `visibility_scope` is OFFLINE_SPEC's own enum (`public|in_room|private`, §12.1); because the shipped WS-Q model (`docs/planning/18-content-and-room-model.md`) uses **room** visibility `public|private` and **story** visibility `public|room_only`, implement an explicit total translation `mapLcapVisibilityToStory` / `mapStoryVisibilityToLcap` (`public ↔ public`; `in_room ↔ room_only`; `private` is reserved for `private_p2p`/WS-S content that LCAP only carries as **ciphertext**, never as a server story) so an accepted LCAP record round-trips into the WS-Q `stories` schema with no ad-hoc coercion or rejected value. It references `capability_cid`, `policy_epoch_claim`, `revocation_epoch_claim`, optional `parent_record_cids`/`replaces_record_cid`/`thread_root_cid`, optional `body_block_cid`/`attachment_manifest_cid`/`source_snapshot_cids`, a `client_nonce`, a `priority`, and `privacy_flags`. Body text lives in a block, never inline (so normalization never perturbs `record_cid`).

**Acceptance criteria:**
- The schema accepts every WS-G contribution type and rejects unknown ones; `mapLcapVisibilityToStory` is total over `public|in_room|private` and round-trips (`in_room↔room_only`) against the WS-Q story schema with no rejected value.
- An `in_room` record reconciles to a `room_only` story; a `private` record is never reconciled into a server `stories` row (it is WS-S ciphertext only).
- Body/attachments are block references; the record body itself is identifier-bearing only; `privacy_flags` are present and consulted by export/replication (WS-R.14).

**Testing:** Unit — type/visibility matrix; block-reference enforcement; round-trip CID stability with varying body text.

**Dependencies:** WS-R.0.7, WS-R.1.2.

---

### WS-R.2.2 Append-only edit / tombstone / moderation semantics
**ID:** WS-R.2.2 | **Ref:** OFFLINE_SPEC §12.3, §25.2

**Description:** Implement edit/deletion/moderation as **new records** referencing earlier ones (`edit → replaces_record_cid`; `tombstone/moderation_action → target_record_cid`; `source correction → target_source_snapshot_cid`). Record bodies are immutable; the visible state is a deterministic projection over the append-only graph plus moderation policy (`reduceThreadProjection`). No record is ever mutated in place.

**Acceptance criteria:**
- Edits/tombstones never mutate prior records; the full edit chain is retained.
- The thread projection is deterministic from the record graph + policy; the stricter visible moderation state wins locally until a fresh checkpoint/policy resolves (§25.1).
- A property test: projection output is independent of record arrival order.

**Testing:** Unit — edit-chain projection; tombstone hiding; arrival-order-independence property.

**Dependencies:** WS-R.2.1.

---

### WS-R.2.3 Display-ordering projection
**ID:** WS-R.2.3 | **Ref:** OFFLINE_SPEC §12.4

**Description:** Implement `displayOrder` using the §12.4 precedence — (1) server/room-log sequence when known, (2) causal parent/reference order, (3) device-sequence order, (4) checkpoint-inclusion order, (5) claimed timestamp as a weak hint, (6) local receipt/import time as last resort. Phone clocks are never trusted for canonical ordering.

**Acceptance criteria:**
- Ordering prefers room-log sequence where present and degrades through the precedence cleanly.
- Claimed timestamps influence only ties not resolvable by causality/sequence/checkpoint.
- A skewed-clock fixture does not reorder causally/sequence-ordered records.

**Testing:** Unit — precedence ladder; clock-skew resistance.

**Dependencies:** WS-R.2.1.

---

### WS-R.2.4 Device-fork detection + fork evidence
**ID:** WS-R.2.4 | **Ref:** OFFLINE_SPEC §12.2, §19.6

**Description:** Implement fork detection: two distinct `record_cid`s sharing `(author_device_key_id, device_seq)` is device-fork evidence (regardless of capability). Emit/store a `fork_evidence` object (the two records + their proofs + observed context) classed C0/P0 and gossiped. Likewise capture checkpoint forks (WS-R.9). Forks mark affected records `conflicting`, never silently discarded.

**Acceptance criteria:**
- A duplicated `(device_key_id, device_seq)` with differing bodies produces fork evidence; identical re-submission does not (idempotent).
- Fork evidence is P0/C0 and schedulable ahead of content.
- Affected records surface as `conflicting` in trust projection (WS-R.8).

**Testing:** Unit — fork vs idempotent-resubmit discrimination; evidence assembly; P0 classification.

**Dependencies:** WS-R.2.1, WS-R.1.3.

---

## WS-R.3 Blocks, chunking, attachments, and compression

### WS-R.3.1 Block descriptor + roles
**ID:** WS-R.3.1 | **Ref:** OFFLINE_SPEC §13.1

**Description:** Implement `BlockDescriptorV2` (`block_cid`, `role ∈ body_text|source_snapshot_text|thumbnail|image|video|encrypted_payload|proof_blob|misc`, `media_type`, `size_bytes`, `sha256`, `priority`, optional chunking/compression descriptors). Blocks are content-addressed by uncompressed canonical bytes unless a block explicitly declares canonical compression (§9.4).

**Acceptance criteria:**
- Descriptor parse-validates; `block_cid` matches `sha256(block_bytes)` for the canonical representation.
- Role + priority drive lane assignment (WS-R.5) and attachment laziness (WS-R.3.3).

**Testing:** Unit — descriptor parse; CID match; role/priority mapping.

**Dependencies:** WS-R.0.3, WS-R.0.7.

---

### WS-R.3.2 Fixed-size chunking + reassembly verification
**ID:** WS-R.3.2 | **Ref:** OFFLINE_SPEC §13.2, §13.3

**Description:** Implement fixed-size chunking with profile defaults (16/32 KiB on unstable/old-phone/mobile; 64 KiB on normal HTTPS; 128/256 KiB on LAN; adaptive for very large media). Each `ChunkDescriptorV2` carries `parent_block_cid`, `chunk_index`, `offset`, `length`, `chunk_sha256`. The receiver verifies **both** each chunk hash and the reassembled block hash. Content-defined chunking is explicitly deferred (CPU cost on cheap phones, §13.3).

**Acceptance criteria:**
- Chunk size adapts to the declared transport profile; very large media never blocks initial render.
- Reassembly verifies each chunk and the final block CID; a single corrupt chunk is localized and re-fetchable.
- CDC is not used in v0.2 (documented deferral).

**Testing:** Unit — chunk/reassemble/verify; single-corrupt-chunk localization; size-profile selection.

**Dependencies:** WS-R.3.1.

---

### WS-R.3.3 Attachment laziness split
**ID:** WS-R.3.3 | **Ref:** OFFLINE_SPEC §13.4

**Description:** Implement the §13.4 split so a media contribution ships as: event record (P1) + body text block (P1) + thumbnail block (P2) + attachment manifest (P2) + full media chunks (P3). The UI MUST render signed text + trust state without full media. Provide `splitContribution` producing the ordered object set with correct lanes/priorities.

**Acceptance criteria:**
- Signed text + trust badges render with media absent; media is fetched on demand.
- The thumbnail/manifest are P2; full media is P3 and never required for initial render.

**Testing:** Unit — split correctness; render-without-media assertion (consumed by WS-R.17 UI test).

**Dependencies:** WS-R.3.1, WS-R.2.1.

---

### WS-R.3.4 Compression via Compression Streams + bomb caps
**ID:** WS-R.3.4 | **Ref:** OFFLINE_SPEC §13.5, §9.4, §27.1

**Description:** Implement pack-level compression (preferred over object-level) using the platform **Compression Streams** API (gzip/deflate; zstd only when a peer explicitly advertises support). Do not compress tiny records; compress source snapshots/text packs when beneficial. CIDs are computed over uncompressed canonical bytes unless a block declares canonical compression (then the descriptor carries `uncompressed_size`/`uncompressed_sha256`/`max_expansion_ratio`). Enforce bounded decompressed size and expansion-ratio limits; reject compression bombs.

**Acceptance criteria:**
- gzip/deflate via Compression Streams with no npm dependency; zstd gated on advertised support.
- Decompression is bounded by `max_uncompressed_bytes`; expansion-ratio breach aborts with `rejected_resource_limit`.
- CID stability holds across compressed/uncompressed transport of the same logical bytes.

**Testing:** Unit — compress/inflate round-trip; bomb rejection at the cap; CID-stability across compression.

**Dependencies:** WS-R.0.3.

---

## WS-R.4 Packfile and `.licio-bundle` format

### WS-R.4.1 Streaming pack writer
**ID:** WS-R.4.1 | **Ref:** OFFLINE_SPEC §14.3, §14.4, §14.5

**Description:** Implement `packages/lcap/src/pack/writer.ts` producing the §14.3 layout: magic `LCAPACK2\n`, LDC `PackHeaderV2`, LDC `PackTableV2` (object table **before** frames so a receiver can decide to import/skip/range-fetch), then `PackFrameV2`s, optional trailer. The writer streams (bounded memory) and is **parameterized by a caller-provided ordered object list** — the scheduler (WS-R.5.2c) produces that order at integration time (WS-R.15.1), so the writer build-depends only on the schemas/codec, not the scheduler. It labels privacy (`privacy_label`) and lanes from the entries it is given.

**Acceptance criteria:**
- Output starts with the magic, then header, then table, then frames; table precedes frames.
- Memory stays bounded for large packs (streamed, not buffered whole).
- Transfer order matches the scheduler decision; `contains_lanes`/`critical_cids` are populated.

**Testing:** Unit — byte-layout assertion; streaming memory bound; table-before-frames invariant.

**Dependencies:** WS-R.0.2a, WS-R.0.3, WS-R.0.7.

---

### WS-R.4.2 Streaming pack reader (bounded memory)
**ID:** WS-R.4.2 | **Ref:** OFFLINE_SPEC §14.3, §14.6, §27.1

**Description:** Implement `packages/lcap/src/pack/reader.ts`: verify magic, parse header/table under resource caps (max pack/header/table/frame/uncompressed sizes, max entries, max dep depth/fan-out), then stream frames verifying each (`frame length ≤ cap`, payload hash matches CID, schema valid, proof matches `record_cid`, deps known-or-declared-missing, critical fields understood, privacy policy permits). Nothing is trusted before trust projection (WS-R.8).

**Acceptance criteria:**
- Every §14.6 frame check is enforced; a frame failing any check is rejected/quarantined, not rendered.
- All §27.1 caps are honored; an oversized header/table/frame aborts early with the right status.
- Parsing is streaming and bounded; a 0-byte or truncated pack fails cleanly.

**Testing:** Unit — frame-check matrix; cap enforcement; truncated/oversized pack handling. Security — fuzz corpus (WS-R.18.4).

**Dependencies:** WS-R.4.1, WS-R.0.6b, WS-R.0.7.

---

### WS-R.4.3 Partial import + quarantine
**ID:** WS-R.4.3 | **Ref:** OFFLINE_SPEC §14.7, §16.11

**Description:** Implement partial import: import the event/proof/text/capability/checkpoint/thumbnail while skipping unwanted full-media chunks; quarantine records with missing dependencies (`quarantined_missing_dependency`) recording reason, first-seen, source hint, missing deps, and byte size. Produce per-object `ObjectStatusV2` for every imported CID.

**Acceptance criteria:**
- A pack with unwanted media imports the renderable core and skips media chunks.
- Missing-dependency records land in quarantine with precise `missing_cids` and become retriable once supplied.
- Each object yields a correct `ObjectStatusV2`.

**Testing:** Unit — selective import; quarantine round-trip (quarantine → deps arrive → promote).

**Dependencies:** WS-R.4.2.

---

### WS-R.4.4 Bundle manifest record + MIME/magic registration
**ID:** WS-R.4.4 | **Ref:** OFFLINE_SPEC §14.2, §14.8

**Description:** Implement the `bundle_manifest` record (a record body, not an authority statement: a manifest signature proves who prepared the bundle, not that contained records are trusted) with `entries`, `purpose`, and optional `export_scope`. Register the `.licio-bundle` extension and `application/vnd.licio.lcap-pack` MIME; high-risk exports allow generic, room/topic-free filenames (§14.2).

**Acceptance criteria:**
- A manifest proof authenticates the preparer only; contained records still pass full validation.
- Extension/MIME/magic are registered; the importer recognizes them.
- High-risk export offers a generic filename that reveals no room/topic.

**Testing:** Unit — manifest build/verify; "manifest ≠ content trust" assertion; filename-privacy option.

**Dependencies:** WS-R.4.1, WS-R.0.6a, WS-R.0.6b.

---

## WS-R.5 Lane scheduler and budgets

### WS-R.5.1 Lane/priority model + byte reservations
**ID:** WS-R.5.1 | **Ref:** OFFLINE_SPEC §15.1, §15.1.1, §15.3

**Description:** Implement the lane model (`C0|T1|E2|M3|B4` per the §15.1.1 canonical `priority↔lane` table — the full five-lane `LcapLane` union from §4.1, `M3` is the media lane) and the §15.3 byte reservations (C0 first 8 KiB then ≥25%; T1 ≥40% after C0 minimum; E2 ≤25%; M3 ≤10% unless media explicitly requested; B4 0% by default). Implement the small-session ladder (≤8/32/128/512 KiB tiers). Lane is a default; an object MAY ship in a non-default lane when closure requires, but only genuine P0 trust/liveness material may enter C0.

**Acceptance criteria:**
- The canonical mapping table is the single source; `priority n`, `Pn`, and the lane agree.
- Reservations hold for every budget; a tiny (≤8 KiB) session carries only C0 material.
- Non-P0 material can never be promoted into C0.

**Testing:** Unit — reservation math across budgets; small-session ladder; C0-purity assertion.

**Dependencies:** WS-R.0.7.

---

### WS-R.5.2a Candidate assembly, policy filtering, and dependency-closure promotion
**ID:** WS-R.5.2a | **Ref:** OFFLINE_SPEC §15.4 (steps 1-3), §17.5

**Description:** Implement the §15.4 front of the scheduler in `packages/lcap/src/scheduler/candidates.ts`: (1) build the candidate set from explicit wants, room interests, the local outbox, and known missing dependencies; (2) **remove** objects forbidden by privacy policy (`privacy_flags`/interest privacy level), the storage/transfer budget, or capability; (3) for each surviving renderable object, **promote its minimal trust/render dependency closure** (WS-R.7.2) into the candidate set and record the `requires` edges so the allocator (WS-R.5.2b) can never place a dependent before a dependency. Output is a `ScheduledCandidate[]` with `{ cid, lane, priority, bytes, requires[], reason }`. This card owns the closure-completeness invariant; the allocator and scorer consume its output.

**Acceptance criteria:**
- A renderable object pulled into the candidate set drags in its full minimal closure (cert/capability/proof/body/parent/checkpoint-summary); a property test asserts no candidate has an unsatisfied `requires` edge after assembly.
- Privacy/budget/capability-forbidden objects are removed *before* closure promotion, and their closures are not pulled in gratuitously.
- The output is a pure function of (wants, interests, outbox, local store, policy) — deterministic for a fixed input.

**Testing:** Unit — closure completeness property; policy-filter matrix; determinism for fixed input.

**Dependencies:** WS-R.5.1, WS-R.7.2.

---

### WS-R.5.2b Deficit-round-robin lane allocation + C0 reservation
**ID:** WS-R.5.2b | **Ref:** OFFLINE_SPEC §15.2, §15.3, §15.4 (steps 5-6)

**Description:** Implement the byte allocator in `packages/lcap/src/scheduler/allocate.ts`: reserve the C0 minimum first (first 8 KiB, then ≥25% until C0 is drained), then run **deficit round robin (DRR)** over the lanes with the §15.3 lane weights — each lane carries a byte "deficit counter" incremented by its weighted quantum each round; a lane may emit its next (topologically-eligible) object only when its deficit ≥ the object's size; leftover deficit carries to the next round. The allocator honors the `requires` edges from WS-R.5.2a (a candidate is *eligible* only once all its `requires` are already placed) and stops before budget overflow. This card owns the **C0-and-dependency-cannot-starve** invariant structurally: the C0 reservation is taken before any DRR round, and eligibility enforces closure ordering.

**Acceptance criteria:**
- C0 bytes are reserved before any M3/B4 byte is allocated, across every budget size and adversarial candidate mix.
- DRR allocation matches a reference table for fixed weights/sizes; an object is emitted only after all its `requires` are placed.
- The allocator never exceeds the budget and is deterministic for fixed input.

**Testing:** Unit — C0-reservation-before-media property; DRR reference table; eligibility (no dependent before dependency); budget-stop.

**Dependencies:** WS-R.5.2a.

---

### WS-R.5.2c Intra-lane scoring, ordering, and pack-table emission
**ID:** WS-R.5.2c | **Ref:** OFFLINE_SPEC §15.4 (steps 4, 7-9)

**Description:** Implement the intra-lane ordering in `packages/lcap/src/scheduler/score.ts`: within a lane, order eligible candidates by **shortest-verifiable-object-first with a deadline boost**, breaking ties by the §15.4 score. Every score factor (priority/want/dependency/freshness/interest/scarcity/trust/deadline and the byte/cpu/privacy divisors) is **clamped to a strictly-positive finite range** (e.g. each weight in `[0.01, 100]`, divisors `≥ 1`), or the score is computed in log-additive form, so a single zero/∞ factor can never un-schedule or NaN an object — scoring only breaks ties *after* the C0 reservation and DRR eligibility (WS-R.5.2b) have run. Emit the final `PackTableV2` in transfer order for the writer (WS-R.4.1).

**Acceptance criteria:**
- The score is always finite; no single factor zeroes/NaNs it; scoring changes only intra-lane order, never the C0/closure guarantees.
- Shortest-verifiable-first + deadline boost are applied within a lane; the emitted table is in valid transfer order.
- The full scheduler (5.2a→b→c) is deterministic for a fixed input and feeds the writer unchanged.

**Testing:** Unit — clamped-score finiteness (incl. zero/∞ inputs); shortest-first + deadline ordering; end-to-end determinism; table-shape for the writer.

**Dependencies:** WS-R.5.2b, WS-R.0.7.

---

### WS-R.5.3 Scarcity boost + user-pin override
**ID:** WS-R.5.3 | **Ref:** OFFLINE_SPEC §15.5, §15.6

**Description:** Implement the scarcity boost (objects with fewer known replicas — from receipt hints, not trusted proofs — score higher) and the user-pin override (pinned content MAY override normal lane weights **after** C0 obligations are satisfied). Replica count derives from distinct recent receipts for a `record_cid`/`block_cid`.

**Acceptance criteria:**
- Scarcer objects receive a higher scarcity weight; receipts are hints only and never bypass validation.
- User-pinned content outranks ambient cache but never preempts C0 obligations.

**Testing:** Unit — scarcity monotonicity in replica count; pin-after-C0 ordering.

**Dependencies:** WS-R.5.2c, WS-R.10.2.

---

### WS-R.5.4 C0-starvation + dependency-closure CI gate
**ID:** WS-R.5.4 | **Ref:** OFFLINE_SPEC §15.2, §32.2

**Description:** Add `pnpm check:lcap-scheduler` (wired into CI) asserting the two scheduler invariants as named gates: **C0 cannot be starved by M3/B4** across adversarial candidate mixes, and **a dependent object is never sent before the dependencies needed to verify/render it**. Includes worst-case fixtures (all-media flood, dependency-bomb shapes within caps).

**Acceptance criteria:**
- The gate fails if any candidate mix lets media/bulk preempt schedulable C0.
- The gate fails if any emitted order places a dependent before a required dependency.
- The gate runs in CI on every PR touching `packages/lcap/src/scheduler`.

**Testing:** The gate itself (property + fixture suite); CI wiring.

**Dependencies:** WS-R.5.2b, WS-R.5.2c.

---

## WS-R.6 Sync protocol (pulse / exchange / fetch)

### WS-R.6.1 Sync pulse + frontiers
**ID:** WS-R.6.1 | **Ref:** OFFLINE_SPEC §16.1, §16.2, §5.3

**Description:** Implement the `SyncPulseV2` (version, node id, session nonce, transport profile, privacy mode, budgets, supported suites/compression/pack versions, checkpoint/revocation/capability frontiers, `critical_have`/`critical_want`, lane summary). The pulse is logically first in every exchange so that if the session dies after the pulse, trust/liveness data has still moved. Implement `buildPulse`/`applyPulse` (frontier diff → wants).

**Acceptance criteria:**
- The pulse carries only frontier/critical material and is emitted before bulk content.
- Frontier comparison yields the correct `critical_want`/`critical_have` deltas.
- A session truncated after the pulse still advances revocation/checkpoint knowledge.

**Testing:** Unit — pulse build/apply; frontier-diff correctness; truncated-after-pulse advancement.

**Dependencies:** WS-R.0.7, WS-R.1.4, WS-R.9.2.

---

### WS-R.6.2 Exchange request/response + budgets
**ID:** WS-R.6.2 | **Ref:** OFFLINE_SPEC §16.3, §16.4, §16.5

**Description:** Implement `ExchangeRequestV2` (pulse + interests + known summaries + ack receipts + optional push pack + wants) and `ExchangeResponseV2` (pulse + status + accepted-push statuses + wanted-from-client + offer summary + response pack + receipts + warnings). Implement `ExchangeBudgetV2` and the rule that clients shrink budgets under battery saver / metered data / low storage / memory pressure / high-risk privacy mode.

**Acceptance criteria:**
- Request/response round-trip carries the scheduled pack within budget; statuses/receipts/wants are populated.
- Budgets shrink under each constraint flag; `minimal_mode` reduces to C0 + smallest T1.
- The `status` enum (`ok|partial|rate_limited|retry_later|auth_required`) is honored by the client.

**Testing:** Unit — request/response assembly; budget-shrink matrix; status handling.

**Dependencies:** WS-R.6.1, WS-R.5.2c.

---

### WS-R.6.3 Interest descriptors + privacy scoping
**ID:** WS-R.6.3 | **Ref:** OFFLINE_SPEC §16.6, §26.1

**Description:** Implement `InterestDescriptorV2` (room id or `room_id_hash`, visibility scope, record kinds, lanes, min priority, since-checkpoint/tree-size, include deps/proofs, privacy level). A client MUST NOT expose private or sensitive room interests to arbitrary peers/relays: for unknown peers, use public room ids only, hashed/opaque room hints, coarse priorities, and no contact/social graph (§26.1).

**Acceptance criteria:**
- Interests to authenticated Licio HTTPS MAY use `room_id`; interests to peers/relays use hashed/opaque hints.
- `privacy_level` gates what an interest may reveal; private-room interest is never leaked to unknown peers.
- A static check forbids constructing a peer-facing interest from a private room id.

**Testing:** Unit — interest scoping by privacy level; peer-facing-private-room rejection.

**Dependencies:** WS-R.6.2.

---

### WS-R.6.4 Wants + range/resume fetch
**ID:** WS-R.6.4 | **Ref:** OFFLINE_SPEC §16.8, §16.10

**Description:** Implement `WantRequestV2` (cid, kind, reason, optional max bytes / byte range / priority override) and the resumable range fetch `GET /api/lcap/v2/blocks/:blockCid/range?offset=N&length=M`. A range response carries block CID, chunk index/byte range, offset, length, total length, and chunk/range hash context; the receiver verifies the reassembled block CID. Interrupted large transfers resume from the last verified chunk.

**Acceptance criteria:**
- Range fetch returns verifiable partial bytes; reassembly verifies the final block CID.
- A want's `reason` (missing_dependency / explicit_user_request / checkpoint_gap / revocation_gap / room_interest / resume_partial / scarce_replica) drives scheduling priority.
- An interrupted transfer resumes without re-fetching verified chunks.

**Testing:** Unit — want assembly; range verify; resume-from-checkpoint correctness.

**Dependencies:** WS-R.3.2, WS-R.6.2.

---

### WS-R.6.5 ACK/status + idempotent ingestion
**ID:** WS-R.6.5 | **Ref:** OFFLINE_SPEC §16.9, §16.11

**Description:** Implement the `ObjectStatusV2` status set (accepted / already_have / stored_pending / stored_unverified / quarantined_* / conflict_device_fork / rejected_*) and idempotent ingestion: repeated submission of the same record body + equivalent proof MUST NOT duplicate application semantics. Acceptance is keyed by `record_cid` + semantic uniqueness (WS-R.12.3).

**Acceptance criteria:**
- Every ingestion outcome maps to exactly one `ObjectStatusV2`; `missing_cids` accompany quarantine.
- Re-submitting an identical record yields `already_have`, never a duplicate effect.
- A conflicting `(device_key_id, device_seq)` yields `conflict_device_fork`.

**Testing:** Unit — status mapping; idempotent re-submit; fork-vs-duplicate.

**Dependencies:** WS-R.6.2, WS-R.2.4.

---

## WS-R.7 Reconciliation and anti-entropy

### WS-R.7.1 Frontier-first reconciliation order
**ID:** WS-R.7.1 | **Ref:** OFFLINE_SPEC §17.1, §17.2, §17.3

**Description:** Implement the §17.1 reconciliation order — (1) revocation frontier, (2) room checkpoint frontier, (3) policy epoch frontier, (4) device sequence frontier for relevant devices, (5) explicit missing-dependency wants, (6) recent object summaries, (7) optional large-cache filters. Implement `CheckpointFrontierV2`/`RevocationFrontierV2` and the rule that a peer behind on revocations is fed revocations first.

**Acceptance criteria:**
- Reconciliation always processes revocations/checkpoints before content summaries.
- A peer whose revocation frontier is behind receives revocation records/summaries with priority.
- Room frontiers use `room_id` only over authenticated HTTPS; peers/relays get hashed/opaque ids.

**Testing:** Unit — reconciliation-order enforcement; behind-peer revocation prioritization.

**Dependencies:** WS-R.6.1, WS-R.1.4.

---

### WS-R.7.2 Dependency-closure assembly
**ID:** WS-R.7.2 | **Ref:** OFFLINE_SPEC §17.5

**Description:** Implement `minimalClosure(record)` as a **pure function** returning the minimal trust/render closure for a renderable contribution — device cert + authority proof, capability + authority proof, contribution + device proof, body text block, parent/root records where needed for context, and the latest known room-checkpoint summary. Large media and old ancestor context are omitted unless explicitly requested. The scheduler (WS-R.5.2a) *consumes* this; closure does not depend on the scheduler.

**Acceptance criteria:**
- The closure is sufficient to reach `authorized_provisional` (or better) for the target without media.
- Old ancestors / large media are excluded by default and only added on explicit want.
- The closure feeds WS-R.5.2a so the allocator can keep dependencies ahead of dependents; closure itself is scheduler-independent.

**Testing:** Unit — closure minimality; sufficiency for trust projection; omission of media/ancestors.

**Dependencies:** WS-R.1.5.

---

### WS-R.7.3 Optional set-reconciliation filters (deferred, non-authoritative)
**ID:** WS-R.7.3 | **Ref:** OFFLINE_SPEC §17.4

**Description:** Provide an optional, non-authoritative set-reconciliation hint layer (Bloom / Golomb-coded sets / IBLT) behind a capability flag. These MUST NOT be authoritative — a false positive can suppress a needed transfer — so a filter "have" is always confirmable by an explicit want. Defaulted off; profiled before any default-on consideration.

**Acceptance criteria:**
- Filters only narrow candidate sets as hints; a missing object is always still reachable via explicit wants.
- The layer is off by default and gated behind capability negotiation.

**Testing:** Unit — false-positive-does-not-suppress property; default-off assertion.

**Dependencies:** WS-R.7.1.

---

## WS-R.8 Trust projection

### WS-R.8.1 Trust-input assembly + state machine
**ID:** WS-R.8.1 | **Ref:** OFFLINE_SPEC §18.1, §18.2

**Description:** Implement the trust-state machine over the §18.2 states (`raw_unverified → integrity_verified → proof_verified → authorized_provisional → stale_authorized → server_stored → server_accepted → checkpointed → witnessed`, plus `conflicting`/`revoked`/`rejected`). Inputs are the §18.1 facts (schema/CID validity, proof, signer/cert/capability status, revocation knowledge, policy epoch, checkpoint inclusion/consistency, witnesses, server receipts, local risk mode). The UI MUST NOT collapse these into one "verified" badge.

**Acceptance criteria:**
- A record's state is the lub of its discharged facts; states never silently upgrade past missing evidence.
- `stale_authorized` is distinct from `authorized_provisional` when the revocation/checkpoint frontier is stale.
- The projection persists to the `trust_projection` store with `missing deps` + `last evaluated`.

**Testing:** Unit — state transitions across fact combinations; staleness distinction.

**Dependencies:** WS-R.1.5, WS-R.1.4.

---

### WS-R.8.2a Validation stage 1 — integrity + proof (steps 1-5)
**ID:** WS-R.8.2a | **Ref:** OFFLINE_SPEC §18.3 (1-5)

**Description:** Implement the first stage of `validate(record_cid)` in `packages/lcap/src/validate/`: (1) load the deterministic record body; (2) verify `record_cid == cidFor('record', body)` → else `rejected_bad_cid`; (3) strict LDC decode + closed-schema parse, rejecting unknown critical fields → `rejected_bad_schema`; (4) load proofs referencing `record_cid`, declaring any missing as `quarantined_missing_dependency`; (5) verify ≥1 applicable detached proof via WS-R.0.6b → `proof_verified`, else `rejected_bad_signature`/`rejected_high_s_signature`. Returns a partial `ValidationResult { state, missing_cids, facts }` at `integrity_verified`/`proof_verified` (or a terminal rejection). This stage needs **no** identity/authority state, so it runs on any object including ones whose certs/caps are not yet present.

**Acceptance criteria:**
- A body whose CID or schema is wrong is rejected at step 2/3 with the exact code; a body with no loadable proof quarantines (not rejects) when the proof CID is merely missing.
- A valid proof advances the record to `proof_verified` with the signer key id recorded in `facts`.
- Stage 1 is pure over (body, proofs) — no store reads beyond the referenced proof objects.

**Testing:** Unit — steps 1-5 success/failure matrix; missing-proof quarantine vs bad-proof reject; `facts` contents.

**Dependencies:** WS-R.8.1, WS-R.0.6b.

---

### WS-R.8.2b Validation stage 2 — authority chain (steps 6-10)
**ID:** WS-R.8.2b | **Ref:** OFFLINE_SPEC §18.3 (6-10)

**Description:** Implement the authority-chain stage by composing `validateIdentityChain` (WS-R.1.5): (6) load signer key + device certificate; (7) verify the certificate authority proof; (8) load the cited capability; (9) verify the capability authority proof; (10) check operation/scope/room/visibility/policy-epoch/quota. Missing cert/capability → `quarantined_unknown_key`/`quarantined_missing_dependency` with precise `missing_cids`; a scope/operation/quota violation → `rejected_policy_denied`/`rejected_quota`; success → `authorized_provisional`. Consumes the stage-1 `facts`.

**Acceptance criteria:**
- A record reaching `authorized_provisional` has a fully-verified cert+capability chain whose operation/scope/policy admit it.
- Each missing link quarantines with the exact missing CID; each policy/quota breach rejects with the exact code — never a false accept.
- Stage 2 reuses WS-R.1.5 verbatim (no second authority implementation).

**Testing:** Unit — steps 6-10 per-link success/missing/violation matrix; `authorized_provisional` only on full chain.

**Dependencies:** WS-R.8.2a, WS-R.1.5.

---

### WS-R.8.2c Validation stage 3 — consensus (steps 11-15) + the single entry point
**ID:** WS-R.8.2c | **Ref:** OFFLINE_SPEC §18.3 (11-15), §18.2

**Description:** Implement the consensus stage and the public `validate(record_cid)` that runs 8.2a→b→c and returns `(trust_state, missing_cids)`: (11) check known revocations (WS-R.1.4) → `revoked`; (12) check device-sequence/fork (WS-R.2.4) → `conflicting`; (13) check checkpoint inclusion if available (WS-R.9.3) → toward `checkpointed`; (14) check checkpoint consistency if available → `conflicting` on a fork; (15) fold all facts into the final state (incl. `stale_authorized` when the local revocation/checkpoint frontier is behind, and `witnessed` when a witness statement is present). `validate` is the **single entry point both client and server call** (one implementation), persisting to `trust_projection`.

**Acceptance criteria:**
- The final state is the lub of all discharged facts; revocation/fork/stale/witnessed are reflected exactly; nothing upgrades past missing evidence.
- Client and server import the same `validate` (a static check forbids a second copy); output is identical on shared fixtures.
- Each terminal routes to the precise status (`revoked`/`conflicting`/`checkpointed`/`stale_authorized`/`witnessed`).

**Testing:** Unit — steps 11-15 matrix; full-pipeline state lub; client≡server output on shared fixtures; missing-deps reporting.

**Dependencies:** WS-R.8.2b, WS-R.2.4, WS-R.9.3, WS-R.1.4.

---

### WS-R.8.3 No-transport-trust enforcement
**ID:** WS-R.8.3 | **Ref:** OFFLINE_SPEC §18.4, §32.2

**Description:** Enforce structurally that the path of arrival never confers trust: every ingress (HTTPS, manual bundle, QR, relay, courier) funnels through `validate(record_cid)` before anything renders. Add a property test "malformed packs never render trusted content" and "a record from a hostile relay and from a trusted friend yield identical trust state." Human trust may gate import willingness only.

**Acceptance criteria:**
- No render path exists that bypasses `validate`; an import source field never appears in the trust computation.
- The two property tests pass; a malformed/hostile pack reaches at most `quarantined_*`/`rejected_*`.

**Testing:** Unit/property — source-independence of trust state; no-render-before-validation; malformed-pack property.

**Dependencies:** WS-R.8.2c, WS-R.4.2.

---

## WS-R.9 Room logs, checkpoints, and witnesses

### WS-R.9.1 Room log append (server canonical order)
**ID:** WS-R.9.1 | **Ref:** OFFLINE_SPEC §19.1, §24.4

**Description:** Implement the server-side append-only canonical room log (`lcap_room_log`: `room_id`, `room_seq`, `record_cid`, `accepted_at`, nullable `checkpoint_cid`). The room-log sequence is the canonical acceptance order for that room, distinct from creation time. Append happens only after validation + policy checks pass (WS-R.12), and processing is topological (certs/capabilities/revocations/checkpoints first; parents before children; moderation policy before affected content).

**Acceptance criteria:**
- A record appends exactly once at a monotonic `room_seq` after acceptance; re-acceptance is idempotent.
- Append order is topological per §24.4; no child precedes a required parent.
- The log feeds checkpoint scheduling (WS-R.9.2) and display ordering (WS-R.2.3).

**Testing:** Gated integration (Postgres) — append ordering; idempotent re-append; topological constraint.

**Dependencies:** WS-R.12.2. (Append is a DB primitive the WS-R.12.1c commit stage calls after validation — the runtime ordering, not a build dependency.)

---

### WS-R.9.2 Merkle tree + checkpoint record
**ID:** WS-R.9.2 | **Ref:** OFFLINE_SPEC §19.1.1, §19.2

**Description:** Implement the §19.1.1 Merkle tree with RFC 6962/9162 domain-separated hashing — empty `= SHA-256("")`, leaf `= SHA-256(0x00 || cid_bytes)` over the 36-byte record `cid_bytes`, node `= SHA-256(0x01 || left || right)`, RFC 6962 §2.1 split. Support both `tree_algorithm` values: `RFC9162_SHA256` (CT-tool compatible, RECOMMENDED) and `LCAP_MERKLE_V2` (leaf prefix `0x00 || domain_separator_hash || cid_bytes` binding the tree to one network). Implement the signed `room_checkpoint` record (root, tree size, policy/revocation epochs, previous checkpoint, signer authority) + its authority proof.

**Acceptance criteria:**
- Leaf/node hashing matches committed vectors for both algorithms; a verifier rejects a proof computed under a different algorithm than the checkpoint names.
- The checkpoint requires a valid authority proof; `tree_size`/`merkle_root`/epochs are bound into the signed body.
- `RFC9162_SHA256` output is byte-compatible with a standard CT verifier.

**Testing:** Unit — tree-hash vectors (both algorithms); checkpoint build/verify; cross-algorithm-proof rejection.

**Dependencies:** WS-R.0.6a, WS-R.0.6b, WS-R.9.1.

---

### WS-R.9.3 Inclusion + consistency proofs
**ID:** WS-R.9.3 | **Ref:** OFFLINE_SPEC §19.1.2, §19.3, §19.4

**Description:** Implement `inclusion_proof` and `consistency_proof` records and the RFC 9162 verification algorithms — inclusion (§2.1.3) recomputes a candidate root from `(leaf_index, tree_size, proof_hashes, leaf_cid)` and requires equality with the checkpoint root; consistency (§2.1.4) requires the new root provably extends the old with no leaf rewritten/removed. A failed consistency check between two checkpoints the same authority signed is fork/equivocation evidence (WS-R.9.4).

**Acceptance criteria:**
- A valid inclusion proof verifies a record's membership against a checkpoint; a tampered proof/leaf fails.
- A valid consistency proof links successive checkpoints; a rewritten-history pair fails and raises fork evidence.
- Verification is byte-compatible with RFC 9162 for `RFC9162_SHA256`.

**Testing:** Unit — inclusion/consistency happy path + tamper; consistency-failure → fork-evidence wiring; vector replay.

**Dependencies:** WS-R.9.2.

---

### WS-R.9.4 Witness statements + checkpoint-fork evidence
**ID:** WS-R.9.4 | **Ref:** OFFLINE_SPEC §19.5, §19.6

**Description:** Implement `witness_statement` (a signed observation of a checkpoint by an independent witness — increases confidence the authority is not silently equivocating; witnesses create no canonical state) and the checkpoint-fork rule: two signed checkpoints for the same room and `tree_size` with different roots is fork evidence — stored as C0/P0 `fork_evidence`, gossiped, and surfaced as a severe consistency warning.

**Acceptance criteria:**
- A witness statement verifies and raises a record's state toward `witnessed`; it never substitutes for inclusion/consistency.
- Two-roots-same-size is detected and produces gossiped C0 fork evidence + a severe UI warning (WS-R.17).
- Fork evidence carries both checkpoints, their authority proofs, and observed context.

**Testing:** Unit — witness verify; checkpoint-fork detection; evidence assembly + P0 classification.

**Dependencies:** WS-R.9.2, WS-R.2.4.

---

## WS-R.10 Liveness model and receipts

### WS-R.10.1 Liveness state machine
**ID:** WS-R.10.1 | **Ref:** OFFLINE_SPEC §20.1, §20.2, §20.3

**Description:** Implement the per-record liveness states (`local_created → local_signed → queued → packed → exported → peer_stored → relay_stored → server_stored → server_accepted → checkpointed → witnessed`) and the §5.5 local-observation timestamps. These are local observations, not global truth, but make delivery health measurable. Implement the §20.3 liveness targets per priority class (C0 ≥8 replicas where possible; T1 3–5 receipts; E2 2; M3 1+demand; B4 none).

**Acceptance criteria:**
- Each record tracks its liveness state + first-reached timestamps; transitions are monotonic forward.
- Liveness reflects only locally observed evidence (receipts/checkpoints), never assumed global delivery.
- Targets are represented and surfaced to the replication-health UI (WS-R.17).

**Testing:** Unit — state advancement on receipt/checkpoint events; monotonicity; target evaluation.

**Dependencies:** WS-R.10.2.

---

### WS-R.10.2 Receipts
**ID:** WS-R.10.2 | **Ref:** OFFLINE_SPEC §20.4, §24.5

**Description:** Implement the `receipt` record (`receipt_type ∈ stored|accepted|rejected|quarantined|evicted|checkpointed`, issuer node id, subject cids, claim/storage-until timestamps, optional per-object status). Receipts are availability hints + audit evidence, **not** proof of content truth. The server emits signed/authenticated receipts for stored/accepted/rejected/quarantined_missing_dependency/checkpointed; clients store them to drive liveness and re-fetch only useful missing items.

**Acceptance criteria:**
- Receipts advance liveness and feed the scarcity hint (WS-R.5.3) but never raise content trust.
- The server returns receipts for the documented outcome set; clients persist them in the `receipts` store.
- A receipt's issuer is identified; a forged-issuer receipt is treated as an untrusted hint only.

**Testing:** Unit — receipt build/parse; "receipt ≠ truth" assertion; liveness advancement.

**Dependencies:** WS-R.0.7.

---

### WS-R.10.3 Outbox durability + hard pins
**ID:** WS-R.10.3 | **Ref:** OFFLINE_SPEC §20.5, §21.2

**Description:** Implement the durable outbox: pin local drafts, signed outbox records, their required proofs and body blocks, export history metadata, and server acceptance/rejection receipts. Pinned outbox data MUST NOT be evicted by normal LCAP GC. Implement retry/next-retry scheduling per outbox entry.

**Acceptance criteria:**
- Outbox entries (and their proofs/blocks) survive normal eviction; only explicit account/app-data deletion removes them.
- A signed-but-unsent record is retried on each sync opportunity (C0 then queued P1 first).
- Export history and server receipts persist for liveness/audit.

**Testing:** Unit — hard-pin survives eviction sweep (property); retry scheduling. Gated — IndexedDB durability.

**Dependencies:** WS-R.11.3.

---

## WS-R.11 Replication policy and local storage

### WS-R.11.1 Priority/pinning classes + eviction order
**ID:** WS-R.11.1 | **Ref:** OFFLINE_SPEC §21.1, §21.2

**Description:** Implement the priority classes (P0–P4) and pinning classes (`hard_pin`/`user_pin`/`policy_pin`/`cache_pin`/`courier_pin`/`relay_pin`) and the §21.2 eviction order (P4 ambient → old M3 → old E2 not user-pinned → old P1 from unsubscribed rooms → quarantine overflow → never hard_pin). GC respects this order strictly.

**Acceptance criteria:**
- Eviction follows the documented order; `hard_pin` is never evicted by normal GC.
- A record's pin class is recorded in `gc_index`; user pins outrank ambient cache.

**Testing:** Unit — eviction-order property over a mixed store; hard-pin invariance.

**Dependencies:** WS-R.11.3.

---

### WS-R.11.2 Storage modes + persistent-storage request
**ID:** WS-R.11.2 | **Ref:** OFFLINE_SPEC §21.3, §23.2

**Description:** Implement the storage modes (Minimal 25–50 MB / Standard 100–250 MB / Courier 500 MB–2 GB / Relay operator-configured / Stealth smallest-practical) with honest storage-pressure display. Request persistent storage via `navigator.storage.persist()` where available; degrade to text/control mode under pressure; cap transaction size for old phones; retry on transient quota errors.

**Acceptance criteria:**
- Each mode enforces its budget and prefetch policy; Stealth disables automatic local discovery/export hints.
- Persistent storage is requested where supported; pressure is shown honestly, not hidden.
- Under pressure the client degrades to C0/T1 and pauses media prefetch.

**Testing:** Unit — mode budget/prefetch policy; pressure-degradation path. E2E — persistent-storage request + pressure UI (WS-R.18.3b storage-pressure scenario).

**Dependencies:** WS-R.11.1.

---

### WS-R.11.3 IndexedDB `lcap_v2` stores
**ID:** WS-R.11.3 | **Ref:** OFFLINE_SPEC §23.1, §23.2

**Description:** Implement the dedicated `lcap_v2` IndexedDB database (separate from the existing `licio` DB) with the §23.1 stores (`records`, `proofs`, `blocks`, `chunks`, `manifests`, `outbox`, `quarantine`, `trust_projection`, `liveness`, `frontiers`, `receipts`, `gc_index`) and indexes for room/priority/state/pin-class. Follow §23.2 best practices: no `getAll` on large stores, cursors/streaming for bundle import/export, blobs/chunk records for large blocks, metadata/blob separation, transactional verification-state commit, capped transaction size, transient-quota retry.

**Acceptance criteria:**
- `lcap_v2` is created with all stores/indexes and never collides with `licio`; a versioned migration path exists.
- Large blocks store as blobs/chunks; import/export streams via cursors; verification state commits transactionally.
- Old-phone caps and transient-quota retry are enforced.

**Testing:** Unit (`fake-indexeddb`) — schema/migration; cursor streaming; transactional commit. Gated — quota-retry path.

**Dependencies:** WS-R.0.1.

---

### WS-R.11.4 Service-worker C0-first sync hooks
**ID:** WS-R.11.4 | **Ref:** OFFLINE_SPEC §23.3

**Description:** Extend the service worker (`apps/web/public/sw-push.js` + `sw-register.ts`) to: trigger a C0-first sync on regained connectivity where supported; queue failed submissions; keep C0 sync tiny and fast; respect data/battery/privacy mode; and never import remote scripts dynamically (the `check:sw` gate stays green). The app also syncs on open/focus/user-action/online events (not solely on background sync, which is unreliable).

**Acceptance criteria:**
- Connectivity regain triggers a minimal C0 exchange; background sync is best-effort, never the only path.
- No remote `importScripts`/`eval`/`new Function` is introduced; `pnpm check:sw` passes post-build.
- Battery-saver/metered/stealth modes suppress or shrink background sync.

**Testing:** Unit — sync-trigger wiring; mode suppression. CI — `check:sw` after build.

**Dependencies:** WS-R.6.1, WS-R.11.2.

---

### WS-R.11.5 Privacy-aware replication
**ID:** WS-R.11.5 | **Ref:** OFFLINE_SPEC §21.4, §26.4

**Description:** Enforce the §21.4 replication policy: public content MAY replicate opportunistically; in-room content follows room policy; **private-room content MUST NOT be exported, relayed, or advertised unless encrypted and explicitly allowed** by room policy and user selection. Encrypted content still leaks size/timing/contact/room-access patterns, so private-room relay/courier support stays conservative until metadata protections are reviewed (bridges to WS-S).

**Acceptance criteria:**
- A private-room record cannot be selected for relay/courier/export unless encrypted + policy-permitted + user-selected.
- `privacy_flags`/`transfer_policy` gate every replication decision; the default for unknown is "do not replicate."
- Private-room metadata-risk warnings are surfaced (WS-R.14).

**Testing:** Unit — replication-eligibility matrix by visibility/transfer policy; private-room default-deny.

**Dependencies:** WS-R.2.1, WS-R.1.2.

---

## WS-R.12 Server ingestion and reconciliation

### WS-R.12.1a Ingestion stage 1 — bounded parse + CAS store
**ID:** WS-R.12.1a | **Ref:** OFFLINE_SPEC §24.1 (parse/CID/schema/store), §27.1

**Description:** Implement the front of `apps/api/src/lcap/ingest.ts`: receive a pack/request → stream-parse under the §27.1 resource caps (WS-R.4.2 reader) → verify CIDs → strict schema → store the raw, CID-verified records/proofs/blocks in the content-addressed store (`lcap_records`/`_proofs`/`_blocks`/`_chunks`) marked `validation_state = stored_unverified`. This stage establishes byte/CID/schema integrity and durability **without** asserting any authority or canonical acceptance; it is safe to run on a hostile pack because nothing it stores is yet trusted or emitted.

**Acceptance criteria:**
- Every stored object is CID- and schema-verified; an object failing either is rejected (not stored) with the exact code.
- All §27.1 caps are enforced at this boundary; an oversized/bombed pack aborts before CAS writes balloon.
- Stored objects are `stored_unverified`; nothing is yet in canonical state or the room log.

**Testing:** Gated integration — parse+store under caps; CID/schema rejection; bomb abort. Unit — CAS write idempotency by CID.

**Dependencies:** WS-R.4.2, WS-R.12.2.

---

### WS-R.12.1b Ingestion stage 2 — dependency resolution + authority/policy validation
**ID:** WS-R.12.1b | **Ref:** OFFLINE_SPEC §24.1 (resolve/verify/check), §24.4

**Description:** Implement the validation stage: resolve dependencies **topologically** (certs/capabilities/revocations/checkpoints first; parents before children; moderation policy before affected content) and run the shared `validate(record_cid)` (WS-R.8.2c — the *same* core the client uses) over each resolved record, checking proofs + authority chain + revocations/policy epochs + capability scopes/quotas + device sequence/forks. Each record emerges as accept-eligible, `quarantined_*` (with precise `missing_cids`), `conflict_device_fork`, or `rejected_*`. No canonical emission happens here — this stage only computes verdicts.

**Acceptance criteria:**
- Resolution is topological; a child is never validated before a required parent/cert/capability.
- The server reuses the client `validate` verbatim (a static check forbids a divergent server copy); verdicts match the client on shared fixtures.
- A missing dependency quarantines with exact `missing_cids`; a fork yields `conflict_device_fork`; nothing is accepted yet.

**Testing:** Gated integration — topological order; verdict matrix; client≡server verdict on shared fixtures.

**Dependencies:** WS-R.12.1a, WS-R.8.2c.

---

### WS-R.12.1c Ingestion stage 3 — accept, room-log append, checkpoint trigger, receipts/wants
**ID:** WS-R.12.1c | **Ref:** OFFLINE_SPEC §24.1 (accept/append/return), §24.2, §24.5

**Description:** Implement the commit stage: for accept-eligible records, idempotently accept by `record_cid` + semantic uniqueness (WS-R.12.3), **append to the room log** (WS-R.9.1) under a transaction, mark `validation_state = server_accepted`, and **trigger the checkpoint schedule** (WS-R.9.2 runs on the maintenance tick). Emit signed/authenticated receipts (WS-R.10.2) for stored/accepted/rejected/quarantined_missing_dependency/checkpointed, and return the per-object `ObjectStatusV2[]` plus `WantRequestV2[]` for the precise missing dependencies. The MUST-NOT-emit-before-validation rule (§24.2) holds because acceptance is the only path that writes the room log.

**Acceptance criteria:**
- Canonical emission (room-log append + `server_accepted`) happens only for records that passed stage 2; quarantined/rejected records never reach the log.
- Acceptance is idempotent by `record_cid`; receipts + statuses + wants are returned for every object.
- The append and state transition are transactional; a crash mid-commit leaves no half-accepted record.

**Testing:** Gated integration — accept-only-after-validation; idempotent re-accept; transactional append; receipts/wants correctness.

**Dependencies:** WS-R.12.1b, WS-R.9.1, WS-R.12.3, WS-R.10.2.

---

### WS-R.12.2 DB schema additions + additive migrations
**ID:** WS-R.12.2 | **Ref:** OFFLINE_SPEC §30

**Description:** Add `packages/db/src/schema/lcap.ts` with the §30 tables (`lcap_records`, `lcap_proofs`, `lcap_blocks`, `lcap_chunks`, `lcap_device_certs`, `lcap_capabilities`, `lcap_capability_usage`, `lcap_revocations`, `lcap_room_log`, `lcap_room_checkpoints`, `lcap_receipts`, `lcap_quarantine`, `lcap_fork_evidence`) and a purely additive Drizzle migration (new tables only; no change to existing tables). Writes preserve Licio's trust-boundary validation style. No table or column may carry a financial field (WS-F.2.5b assertion + wallet↔ranking BFS isolation re-run).

**Acceptance criteria:**
- The migration is additive and idempotent with a clean down path (drop new tables).
- Schema mirrors the spec's CAS/validation-state model; FKs link records↔proofs↔blocks↔chunks/room-log/checkpoints.
- Financial-denylist + BFS-isolation gates stay green on the modified schema.

**Testing:** Gated integration (Postgres) — apply/rollback; FK integrity. Unit — DB↔shared enum/shape mirror; denylist assertion.

**Dependencies:** WS-R.0.7.

---

### WS-R.12.3 Idempotent acceptance + semantic uniqueness
**ID:** WS-R.12.3 | **Ref:** OFFLINE_SPEC §24.3

**Description:** Implement canonical acceptance keyed by `record_cid` + semantic uniqueness constraints: a repeated event with the same `record_cid` is `already_have`; a different `record_cid` with the same `(author_device_key_id, device_seq)` is fork evidence (WS-R.2.4). Enforce final capability usage independently of the client's local accounting (WS-R.1.3).

**Acceptance criteria:**
- Re-submitting an accepted record is a no-op returning `already_have`.
- A sequence-colliding distinct record yields fork evidence, never a second canonical record.
- Server-side quota enforcement is authoritative; over-quota submissions are `rejected_quota`.

**Testing:** Gated integration — idempotent re-accept; fork detection; quota enforcement.

**Dependencies:** WS-R.12.2, WS-R.2.4, WS-R.1.3. (Acceptance primitive consumed by the WS-R.12.1c commit stage.)

---

### WS-R.12.4 HTTP API routes + status mapping
**ID:** WS-R.12.4 | **Ref:** OFFLINE_SPEC §29, §22.1, §22.1.1

**Description:** Implement `apps/api/src/lcap/routes.ts` (Hono) for the §29 endpoints: `POST /api/lcap/v2/pulse`, `POST /api/lcap/v2/exchange`, `POST /api/lcap/v2/packs`, `GET …/records/:cid`, `GET …/proofs/:cid`, `GET …/blocks/:cid` and `…/range`, the room checkpoint/inclusion/consistency reads, and bundle import/export (which MUST use the same pack validation as every other path). Apply the §22.1.1 HTTP status mapping (200/202/400/401/403/409/413/422/429+Retry-After/503) distinct from per-object `ObjectStatusV2`. CSRF/cookie/security-header middleware applies as elsewhere.

**Acceptance criteria:**
- Every endpoint is idempotent where the spec requires; bundle import shares the WS-R.4.2 validator.
- Request-level HTTP status follows the §22.1.1 table; `429`/`503` set `Retry-After`; `400`/`422` are non-retriable.
- Endpoints honor budgets/caps and never trust transport.

**Testing:** Gated integration — endpoint contract + status-code matrix; bundle-import-uses-same-validator; rate-limit `429`.

**Dependencies:** WS-R.12.1c, WS-R.6.2, WS-R.9.3.

---

## WS-R.13 Conflict handling

### WS-R.13.1 Conflict-table dispatch
**ID:** WS-R.13.1 | **Ref:** OFFLINE_SPEC §25.1

**Description:** Implement the §25.1 conflict dispatch: bad CID/schema → reject; bad signature → reject proof, keep body only as untrusted forensic material; unknown key/cert/capability → quarantine + request missing deps; expired capability → reject/quarantine per room policy; revoked → mark revoked, never render trusted; device-sequence fork → mark conflicting + gossip fork evidence; edit conflict → deterministic projection preserving the full edit chain; moderation conflict → stricter visible state wins locally until fresh checkpoint/policy; checkpoint fork → severe consistency warning + gossip.

**Acceptance criteria:**
- Each conflict class routes to the documented outcome and status code.
- A bad-signature body is retained only as untrusted forensic data, never rendered.
- Fork/checkpoint-fork conflicts always gossip evidence and never silently drop data.

**Testing:** Unit — conflict-class dispatch matrix; "no silent discard" property.

**Dependencies:** WS-R.8.2c, WS-R.2.4, WS-R.9.4.

---

### WS-R.13.2 Deterministic thread projection
**ID:** WS-R.13.2 | **Ref:** OFFLINE_SPEC §25.2

**Description:** Implement the per-thread visible-state projection from canonical room-log order (when known) + valid moderation actions + valid edits/tombstones + room policy + local trust state + user safety mode. No client silently discards conflicting evidence; conflicting items are surfaced, not dropped.

**Acceptance criteria:**
- The projection is deterministic and identical across clients with the same accepted set + policy.
- Conflicting evidence remains inspectable; the safer/stricter state is shown by default.
- Local safety mode can further restrict but never silently delete.

**Testing:** Unit — projection determinism; conflicting-evidence visibility; cross-client equality on shared fixtures.

**Dependencies:** WS-R.13.1, WS-R.2.2.

---

## WS-R.14 Privacy and denial-of-service controls

### WS-R.14.1 Resource caps + malicious-graph detection
**ID:** WS-R.14.1 | **Ref:** OFFLINE_SPEC §27.1, §27.2

**Description:** Centralize the §27.1 caps (max pack/header/table/frame/uncompressed sizes, max compression ratio, max manifest entries, max dependency depth, max missing deps per object, max proofs per record, max signature failures per import, max quarantine bytes, max CPU time per import batch) and the §27.2 malicious-graph detectors (cycles, excessive fan-out/depth, duplicate deps, private metadata in public exports, unknown critical fields). Every parser path consumes the shared cap config.

**Acceptance criteria:**
- Every cap is enforced at the single shared chokepoint; a breach aborts with `rejected_resource_limit`.
- Cyclic/over-fan-out/over-deep dependency graphs are detected and rejected before expansion.
- Private metadata in a public export is detected and blocked.

**Testing:** Unit — each cap boundary; graph-attack detection. Security — fuzz + dependency-bomb corpus (WS-R.18.4).

**Dependencies:** WS-R.4.2.

---

### WS-R.14.2 Interest/bundle privacy + stealth mode
**ID:** WS-R.14.2 | **Ref:** OFFLINE_SPEC §26.1, §26.2, §26.3

**Description:** Implement the export privacy warning (rooms included, in-room/private metadata present, encrypted payloads present, approximate size, media included, identities/device ids included, that recipients may copy onward) and stealth mode (disable automatic local discovery + courier advertising + background relay sync; generic filenames; C0-only unless user-initiated; confirm before export; minimal cache). Interest descriptors to unknown peers reveal only public/opaque hints (WS-R.6.3).

**Acceptance criteria:**
- Export shows the full §26.2 disclosure before producing a bundle.
- Stealth mode disables discovery/advertising/background sync and uses generic filenames.
- No private-room membership/contact/social-graph leaks to unknown peers or relays.

**Testing:** Unit — disclosure completeness; stealth-mode toggles. E2E — export-warning flow (WS-R.15.1 import/export E2E).

**Dependencies:** WS-R.6.3, WS-R.4.4.

---

### WS-R.14.3 LCAP doctrine gates
**ID:** WS-R.14.3 | **Ref:** OFFLINE_SPEC §3.7, §36

**Description:** Extend `check:no-raw-egress` and `check:no-applause` to scan `packages/lcap`, `apps/web/src/lcap`, and `apps/api/src/lcap`, and add `check:lcap-schema-egress` asserting no IP/location/attention-trace field name (scrollX, clientY, dwellMs, ip, geo, …) and no like/vote/karma/reaction/follower field appears in any LCAP record/proof/receipt schema. Wire all three into CI.

**Acceptance criteria:**
- The extended gates fail on any forbidden field name or applause affordance in LCAP source.
- `check:lcap-schema-egress` enumerates the LCAP schema surface and asserts the denylist.
- All three run in CI on every PR touching LCAP trees.

**Testing:** The gates themselves (positive + negative fixtures); CI wiring.

**Dependencies:** WS-R.0.7.

---

### WS-R.14.4 Relay quotas + no client proof-of-work
**ID:** WS-R.14.4 | **Ref:** OFFLINE_SPEC §27.3, §27.4

**Description:** Implement relay-side reserved capacity + quotas (C0/T1 reserved space, per-peer quota, per-room quota, max object size, max invalid-object ratio, max unverified quarantine). Proof-of-work for client posting is NOT used in v0.2 (it burns scarce battery and disadvantages low-end phones, §27.4); relay-specific abuse controls MAY be evaluated later. Rate limiting follows the identity-free Section 19.1 posture (no per-IP state in app logic).

**Acceptance criteria:**
- Relays reserve C0/T1 capacity and enforce per-peer/per-room quotas + invalid-ratio limits.
- No client posting path requires proof-of-work.
- Abuse control reads no client network address (Section 19.1 parity).

**Testing:** Unit — quota/reservation enforcement; no-PoW assertion; no-client-address assertion.

**Dependencies:** WS-R.0.7. (Relay quotas are a standalone reusable policy; the relay service WS-R.15.3 *consumes* this — the back-edge in the first cut is removed so the two cards schedule.)

---

## WS-R.15 Transport profiles

### WS-R.15.1 Manual `.licio-bundle` export/import flow
**ID:** WS-R.15.1 | **Ref:** OFFLINE_SPEC §22.2

**Description:** Implement the REQUIRED manual bundle transport in `apps/web/src/lcap/bundleExport.ts` / `bundleImport.ts`: export (choose scope → privacy warning → size estimate → included lanes/priorities → stream pack → save/share file → record `exported` liveness) and import (select file → check size/magic → parse header/table under caps → summary before render → stream frames → verify CIDs/schemas/proofs → quarantine missing deps → commit verified/provisional → update liveness). Uses the platform File System Access / download + file-input APIs (no npm dependency).

**Acceptance criteria:**
- Export shows the privacy warning + size + lanes before producing the file and records `exported` liveness.
- Import shows a summary before rendering, verifies every frame, and quarantines missing deps — nothing renders before trust projection.
- Round-trip: a bundle exported from one profile imports into another with no semantic change (WS-R.18.5).

**Testing:** E2E (Playwright + axe) — export/import happy path + malformed-file rejection; a11y on each state.

**Dependencies:** WS-R.4.1, WS-R.4.2, WS-R.14.2.

---

### WS-R.15.2 QR micro-bundle profile
**ID:** WS-R.15.2 | **Ref:** OFFLINE_SPEC §22.3

**Description:** Implement the QR micro-bundle for tiny control material (checkpoint/revocation frontier, room invite/contact card, tiny signed emergency notice, small manifest pointer, relay contact card). **Import decodes a QR from a user-supplied still image (file picker / pasted screenshot / photo), NOT a live camera stream** — the app-wide `Permissions-Policy: camera=()` (asserted in the security-header tests) blocks `getUserMedia`, so v0.2 QR import is image/file-based and needs no camera exception; a live-camera scanner would require a narrowly-scoped permissions-policy change + new tests and is out of scope. QR MUST show a human-readable summary before display or import. Multi-QR large content is deferred unless carefully designed/tested. QR encode/decode uses a minimal, audited, install-script-free helper inside the lazily-loaded LCAP chunk (dependency-budget reviewed).

**Acceptance criteria:**
- QR carries only C0/tiny control objects; a human-readable summary precedes any import.
- Import decodes from a still image (no `getUserMedia`/camera); the flow works under the unchanged `camera=()` policy.
- Imported QR material runs the full validation pipeline (no transport trust); multi-QR is gated off by default (documented deferral).

**Testing:** Unit — QR encode + image-decode round-trip for frontier/revocation cards; summary-before-import. E2E — image-file import flow (no camera permission requested).

**Dependencies:** WS-R.6.1, WS-R.14.2.

---

### WS-R.15.3 Local relay service (untrusted object store)
**ID:** WS-R.15.3 | **Ref:** OFFLINE_SPEC §22.4, §33.4

**Description:** Implement an optional untrusted relay (operator-run) that MAY store records/proofs/blocks by CID, exchange pulses/packs, enforce quotas, verify CIDs + basic schemas (optionally signatures for resource protection), gossip public C0/P1 upstream, and serve LAN clients without internet — but MUST NOT mark content globally accepted, rewrite records, bypass proof validation, require private-room metadata, store private content unless encrypted+permitted, or silently advertise users. Observability without user surveillance.

**Acceptance criteria:**
- A relay stores/serves by CID and returns storage receipts but never emits `accepted`/canonical state.
- The relay enforces quotas + invalid-ratio limits and refuses private content unless encrypted+permitted.
- LAN-only operation works with no upstream; upstream sync is opportunistic.

**Testing:** Gated integration — relay store/serve/receipt; "relay cannot accept" assertion; quota + private-content refusal.

**Dependencies:** WS-R.12.4, WS-R.14.4.

---

> **Dependency posture (elevated transports — WS-R.15.4 onward).** The 2026-06 maintainer
> decision elevates the native courier and the browser-P2P/WebTransport/IPFS bridges to
> first-class, in-scope v0.2 transports. To honor it **without** regressing Licio's hard
> budgets, the heavier browser deps (WebRTC plumbing + Helia/js-libp2p) live in a dedicated
> optional workspace package **`@licio/lcap-p2p`** (`workspace:*`, excluded from the
> `apps/web` `<15` direct-production-dep count) that is loaded **only** from a separately
> code-split `apps/web/src/lcap/transports/` chunk (never in the < 200 KB initial bundle); the
> native courier's `@capacitor/*` deps live in a new **`apps/courier`** native-shell project
> (build/native scope, not a web production dep); WebTransport uses the platform API (no dep).
> All three reuse the *same* packs, the single `validate(record_cid)`, the lane scheduler, and
> the trust pipeline (no parallel data model or trust path), are **off by default and
> consent-gated per operational mode** (disabled in Stealth/Emergency), and never let
> transport-layer metadata (peer IP, multiaddr, radio id) enter any LCAP schema. **Correctness
> never depends on any single transport** — HTTPS + manual bundle remain sufficient alone.

**WS-R.15.4 — Native Android courier (Capacitor), cards a–f.** The previously-deferred Android courier is now a shipped, first-class transport that moves the *same* packs over native radio links via a Capacitor shell wrapping the unchanged web client; it is decomposed into the six cards below (15.4a–f).

### WS-R.15.4a Capacitor native shell + native-build CI
**ID:** WS-R.15.4a | **Ref:** OFFLINE_SPEC §22.5, §33.3, §31

**Description:** Scaffold `apps/courier/` as a Capacitor Android project that loads the **unchanged** built web client (same CSP, Trusted Types, service worker, and `lcap_v2` IndexedDB) inside the system WebView, plus a `pnpm --filter courier build` + a new native-build CI job that produces a debug APK. The courier is the *same* PWA in a native shell — **no courier-only web fork, no parallel data model.** `@capacitor/*` and plugin deps are confined to `apps/courier` (build/native scope) and never added to `apps/web` production deps, so `check:deps` (`apps/web` < 15) and the initial-bundle gate are unaffected.

**Acceptance criteria:**
- `apps/courier` builds a debug APK in CI; the loaded client is byte-identical to the web build (a hash check forbids a courier-only fork).
- CSP / Trusted Types / service-worker posture survives in the WebView (no `script-src`/TT relaxation); `check:deps` web budget and the < 200 KB initial-bundle gate are unchanged.
- Native deps live only in `apps/courier`; the Section 6.12.12 dependency-addition checklist (no install scripts, AGPL-compatible license, transitive review, SBOM) passes.

**Testing:** Native-build CI smoke (APK builds, app boots, client hash matches the web build); CSP-in-WebView assertion.

**Dependencies:** WS-R.15.1, WS-R.11.4.

---

### WS-R.15.4b Courier transport adapter over the shared `LcapTransport` seam
**ID:** WS-R.15.4b | **Ref:** OFFLINE_SPEC §22.5, §16.3, §18.4

**Description:** Define/realize the shared `LcapTransport` interface (pulse / exchange / want / range over an abstract bidirectional byte channel — the same seam the HTTPS and relay transports implement) and implement `CourierTransport`, which streams the *same* scheduler-ordered packs (WS-R.5.2c) over a native channel handle. The adapter performs **no** validation of its own: every received frame goes through the WS-R.4.2 reader + `validate(record_cid)` exactly as HTTPS does. This card structurally establishes "no separate trust path" for the courier and is the seam WebRTC (15.6) and WebTransport (15.5) also implement.

**Acceptance criteria:**
- `CourierTransport` implements the identical `LcapTransport` seam as HTTPS/relay; a property test asserts a courier-delivered pack and an HTTPS-delivered pack reach **identical** trust state (source-independence, §18.4).
- The adapter streams scheduler-ordered packs with bounded memory and never bypasses the reader/validator.

**Testing:** Unit — adapter conforms to the seam; source-independence property (courier ≡ HTTPS trust state); streaming-memory bound.

**Dependencies:** WS-R.4.2, WS-R.5.2c, WS-R.8.3.

---

### WS-R.15.4c Nearby Connections typed plugin + chunked pack streaming
**ID:** WS-R.15.4c | **Ref:** OFFLINE_SPEC §22.5, §13.2

**Description:** Implement a typed Capacitor plugin bridging Android **Nearby Connections** (advertise / discover / request-connection / accept / send-payload / receive) to TS as an `LcapTransport` byte channel; stream packs as bounded chunks (transport-profile chunk sizes, §13.2) with backpressure; verify each reassembled block CID on receipt. The JS↔native boundary is strict-zod-validated and bounded by the §27.1 resource caps.

**Acceptance criteria:**
- The plugin advertises/discovers, establishes a Nearby channel, and streams packs as size-profiled chunks that reassemble with per-chunk **and** block-CID verification.
- The JS↔native boundary is zod-validated and cap-bounded; a malformed native payload fails closed (`rejected_*`/`quarantined_*`), never crashes the shell.

**Testing:** Native instrumentation/contract test (two emulators exchange a pack); JS-boundary zod accept/reject matrix; chunk/reassembly verification.

**Dependencies:** WS-R.15.4a, WS-R.15.4b, WS-R.3.2.

---

### WS-R.15.4d Wi-Fi Direct / local hotspot / Bluetooth / USB channels
**ID:** WS-R.15.4d | **Ref:** OFFLINE_SPEC §22.5

**Description:** Extend the courier with the remaining §22.5 channels behind the *same* `CourierTransport` adapter: Wi-Fi Direct + local hotspot (higher-throughput LAN ferry), Bluetooth file transfer (low-bandwidth C0/T1 ferry), and USB import/export (reuses the WS-R.15.1 `.licio-bundle` path — **no new format**). Each channel selects chunk size and lane budget from its transport profile (§13.2/§15) so Bluetooth stays C0-first while LAN uses larger chunks.

**Acceptance criteria:**
- Each channel moves the same packs through the same adapter; chunk size + lane budget follow the channel's transport profile (LAN larger; Bluetooth small + C0-first).
- USB transfer is exactly a `.licio-bundle` import/export (no courier-specific format or trust path).

**Testing:** Per-channel contract test; transport-profile-selection unit; USB-equals-bundle-path assertion.

**Dependencies:** WS-R.15.4c.

---

### WS-R.15.4e Courier controls, private-content exclusion, and metadata-privacy disclosure
**ID:** WS-R.15.4e | **Ref:** OFFLINE_SPEC §22.5, §26.2, §26.3, §33.5

**Description:** Implement the mandatory §22.5 explicit controls (discovery on/off, advertising on/off, who-can-exchange, which rooms/priorities are shared, storage budget, battery budget, **private-content exclusion** default-deny) and the courier privacy disclosure enumerating radio-metadata exposure (device name, endpoint/MAC id, physical proximity, who can see you advertising). Stealth/Emergency modes force discovery **and** advertising off; private/in-room/ciphertext content is never advertised or sent over the courier unless encrypted + room-policy-permitted + user-selected (WS-R.11.5). No radio/peer identifier is ever written to an LCAP schema (`check:lcap-schema-egress` covers `apps/courier`).

**Acceptance criteria:**
- All seven §22.5 controls exist and default conservative; private-content exclusion is default-deny and enforced **before** any pack is offered to a peer.
- The radio-metadata disclosure renders before advertising/discovery starts; Stealth/Emergency force the radios off.
- No radio/peer identifier appears in any LCAP record/proof/receipt; the schema-egress gate scans courier source.

**Testing:** Unit — control matrix + private-exclusion default-deny; Stealth/Emergency force-off; schema-egress gate over courier source. E2E — disclosure-before-discovery flow.

**Dependencies:** WS-R.15.4b, WS-R.11.5, WS-R.14.2, WS-R.17.2.

---

### WS-R.15.4f Courier integration, two-device E2E, and simulator ferry scenario
**ID:** WS-R.15.4f | **Ref:** OFFLINE_SPEC §22.5, §32.3, §38

**Description:** Wire the courier into the WS-R.18.3a discrete-event simulator as a "radio ferry" link model (intermittent proximity, asymmetric bandwidth) with a malicious-courier strategy (withhold / flood / lie) and assert the §32.3 metrics (C0 ahead of media over the ferry; fork/revocation propagation within bounded contacts). Add the native-bridge contract E2E (two emulators converge a room thread with **no internet**) and confirm the manual-file-bridge fallback when radios are off. Map the courier risks into the §38 register.

**Acceptance criteria:**
- The simulator runs a courier-ferry scenario with the malicious-courier strategy; metrics hold (media never beats C0; fork detected within bounded contacts).
- A two-device emulator E2E converges a room thread offline-only; the manual-file-bridge fallback works with radios disabled.
- Courier risks (radio metadata, native attack surface) appear in the §38 register with mitigations.

**Testing:** Simulation scenario + metric assertions; two-emulator integration E2E; radios-off fallback path.

**Dependencies:** WS-R.15.4d, WS-R.15.4e, WS-R.18.3a.

---

### WS-R.15.5 WebTransport (HTTP/3) server transport
**ID:** WS-R.15.5 | **Ref:** OFFLINE_SPEC §22.6

**Description:** Implement a WebTransport (HTTP/3 / QUIC) `LcapTransport` for browser↔server pack exchange as a lower-latency, loss-tolerant alternative to HTTPS on flaky mobile links; it reuses the §16 exchange protocol, the scheduler order, and the single `validate`. Uses the **platform** `WebTransport` API (no npm dependency) and MUST fall back to HTTPS when unsupported or blocked — correctness never depends on it. A session-bound handshake preserves the same auth/CSRF posture as the HTTPS routes.

**Acceptance criteria:**
- Browser↔server pack exchange works over WebTransport with automatic HTTPS fallback; the wire protocol + validation are identical to the HTTPS path (no parallel model).
- No new npm dependency (platform API); the session-bound handshake preserves the auth/CSRF posture; correctness holds with WebTransport disabled.

**Testing:** Gated integration — WebTransport exchange + HTTPS-fallback equivalence; auth-bound handshake; same-`validate` assertion.

**Dependencies:** WS-R.12.4, WS-R.6.2.

---

### WS-R.15.6a WebRTC data-channel P2P transport + HTTPS signaling
**ID:** WS-R.15.6a | **Ref:** OFFLINE_SPEC §22.6, §16.3, §18.4

**Description:** In the code-split `@licio/lcap-p2p` package, implement a WebRTC `RTCDataChannel` `LcapTransport` for browser↔browser pack exchange. **Signaling (SDP/ICE) rides the existing Licio HTTPS API** via a session-bound `POST /api/lcap/v2/p2p/signal` rendezvous, with public STUN for NAT discovery. It reuses the `LcapTransport` seam (WS-R.15.4b), the scheduler order, and `validate`; it is **off by default**. The WebRTC + (15.7) Helia deps live behind the `@licio/lcap-p2p` workspace boundary and a separately code-split `apps/web/src/lcap/transports/` chunk so the web `<15` budget and the < 200 KB initial-bundle gate both hold.

**Acceptance criteria:**
- Two authenticated browsers establish an `RTCDataChannel` via HTTPS signaling + STUN and exchange a scheduler-ordered pack; received frames go through the same reader/validator (source-independence holds).
- The transport is off by default and opt-in per mode; `@licio/lcap-p2p` is `workspace:*`-excluded and the chunk is separately code-split (budgets green).

**Testing:** Gated/E2E (two Playwright contexts) — datachannel exchange + trust-state equivalence to HTTPS; budget + code-split assertions.

**Dependencies:** WS-R.15.4b, WS-R.12.4, WS-R.5.2c.

---

### WS-R.15.6b WebRTC NAT traversal + connection-privacy controls
**ID:** WS-R.15.6b | **Ref:** OFFLINE_SPEC §22.6, §26.2, §26.4, §33.5

**Description:** Add NAT traversal — STUN-first with **optional self-hosted TURN, off by default** — and the connection-privacy controls: a clear disclosure that a *direct* WebRTC connection exposes peer IPs to the other party (via ICE candidates), a "relay-only ICE (hide my IP via TURN)" option, and **force-disable in Stealth/Emergency**. Peer IPs/ICE candidates are a live-connection property only and are never written to any LCAP schema (`check:lcap-schema-egress` covers `@licio/lcap-p2p`). Private/in-room content is default-deny over P2P unless encrypted + permitted (WS-R.11.5).

**Acceptance criteria:**
- STUN-first with optional TURN; the IP-exposure disclosure precedes any direct connection; relay-only-ICE masks the IP via TURN when selected; Stealth/Emergency force WebRTC off.
- No peer IP/ICE candidate is persisted in an LCAP record/proof/receipt; the schema-egress gate scans the P2P source.

**Testing:** Unit — STUN/TURN config + relay-only-ICE path; disclosure-before-connect; Stealth force-off; schema-egress gate over P2P source.

**Dependencies:** WS-R.15.6a, WS-R.11.5, WS-R.14.2.

---

### WS-R.15.7a Browser IPFS/libp2p (Helia) public-block bridge, code-split
**ID:** WS-R.15.7a | **Ref:** OFFLINE_SPEC §22.7, §13.1, §9.2

**Description:** In `@licio/lcap-p2p`, implement a Helia / js-libp2p bridge that publishes and fetches **public blocks only** by their LCAP `block_cid` (content addressing reuses the §9 CIDs; bitswap exchange), loaded **only** from the separately code-split transports chunk so the initial-bundle gate holds. A fetched block is verified against its `block_cid` exactly like any other ingress (no transport trust); the bridge stores/serves nothing private/in-room/ciphertext. Off by default.

**Acceptance criteria:**
- The bridge publishes/fetches public blocks by `block_cid`; a fetched block is CID-verified before use (no transport trust); only `public`-visibility blocks are selectable.
- Helia/js-libp2p is confined to `@licio/lcap-p2p` (workspace-excluded) and the separately code-split chunk; the < 200 KB initial-bundle and `apps/web` `<15` budgets hold; the dependency-addition checklist (no install scripts, license, transitive count, SBOM) passes.

**Testing:** Gated/E2E — publish/fetch a public block by CID + CID-verify; public-only selection; bundle-size + code-split + budget assertions.

**Dependencies:** WS-R.15.6a, WS-R.3.1, WS-R.0.3.

---

### WS-R.15.7b IPFS publish review gate + public-only structural enforcement
**ID:** WS-R.15.7b | **Ref:** OFFLINE_SPEC §22.7, §37.2, §21.4, §26.4

**Description:** Implement the **required** privacy/moderation/abuse-review gate that must pass before any block is published to the public DHT, plus structural public-only enforcement: a block is publishable only if its source record is `public` visibility (never `in_room`/`private`/ciphertext, never a private-room hint), confirmed against the WS-Q visibility model and WS-J takedown state. Published-block provenance is auditable, and a WS-J takedown retracts further republication.

**Acceptance criteria:**
- No block reaches the public DHT without passing the review gate; only `public`-visibility blocks qualify (in_room/private/ciphertext structurally excluded).
- A WS-J takedown halts further republication of the affected block; the gate decision is audited.

**Testing:** Unit — public-only enforcement matrix (each visibility/ciphertext case); review-gate-required; takedown-halts-republish.

**Dependencies:** WS-R.15.7a, WS-R.11.5.

---

### WS-R.15.8 Transport dependency-budget governance + metadata-privacy gates
**ID:** WS-R.15.8 | **Ref:** OFFLINE_SPEC §31.1, §3.7, §26.4; CLAUDE.md Section 6.12.12

**Description:** Make the optional-transport dependency posture structurally enforced rather than conventional: assert `@licio/lcap-p2p` is `workspace:*` and excluded from the `apps/web` `<15` direct-production-dep count; assert the WebRTC/Helia code lives only in a separately code-split chunk (initial-bundle gate unaffected); extend `check:lcap-schema-egress` + `check:no-raw-egress` + `check:no-applause` over `@licio/lcap-p2p` and `apps/courier`; run the Section 6.12.12 dependency-addition checklist (install-script ban, license, transitive review) and update the SBOM for Helia / js-libp2p / `@capacitor/*`. Register `@licio/lcap-p2p` in `scripts/check-workspace-deps.ts` (allowed deps: `@licio/shared`, `@licio/lcap`).

**Acceptance criteria:**
- CI proves the P2P deps never enter the initial bundle and never count against the web direct-dep budget; a deliberately mis-placed Helia import in `apps/web` source fails a gate.
- The extended egress/applause/schema-egress gates scan the new trees; the SBOM includes the new transitive trees; install-script detection stays green.

**Testing:** The gates themselves (positive/negative fixtures); SBOM diff; budget + code-split assertions; CI wiring.

**Dependencies:** WS-R.15.6a, WS-R.15.7a, WS-R.14.3.

---

### WS-R.15.9 Transport simulator scenarios + interop + correctness-independent-of-transport
**ID:** WS-R.15.9 | **Ref:** OFFLINE_SPEC §22.6, §22.7, §32.3, §32.5

**Description:** Add WebTransport / WebRTC / IPFS link models + adversary strategies (DHT flood/eclipse, malicious WebRTC peer, NAT-blocked, signaling-server-down) to the WS-R.18.3a simulator and assert: C0 is never starved over any transport; fork/revocation propagate; and the **correctness-independent-of-transport** property — the *same* accepted set + trust state is reached with any subset of transports enabled, HTTPS-only included. Cross-transport interop: a block published via IPFS, a pack ferried by courier, and one fetched over WebRTC all reconcile to identical canonical state.

**Acceptance criteria:**
- Each transport scenario runs with its adversary strategy; the C0-cannot-starve and fork/revocation metrics hold across transports.
- A property test: enabling/disabling any transport subset yields the identical accepted set + trust projection (transport-independence).
- Cross-transport interop reconciles to one canonical state.

**Testing:** Simulation scenarios + metric assertions; transport-independence property; cross-transport interop.

**Dependencies:** WS-R.15.5, WS-R.15.6b, WS-R.15.7b, WS-R.18.3a.

---

## WS-R.16 Private-room encryption envelope (LCAP-side carrier)

### WS-R.16.1 Encrypted-payload envelope carrier
**ID:** WS-R.16.1 | **Ref:** OFFLINE_SPEC §28; PRIVATE_SPEC §10

**Description:** Implement the minimal LCAP-side `EncryptedPayloadDescriptorV2` carrier (suite, key-epoch id, nonce, AAD context, ciphertext block CID, optional plaintext hash/size) so LCAP can transport ciphertext blocks and opaque room hints for `private_p2p` rooms **without** owning the key schedule. The authoritative private-room envelope, key derivation, and AAD construction live in WS-S / `docs/PRIVATE_SPEC.md` §10; where the two disagree for private-room content, PRIVATE_SPEC wins. LCAP MUST NOT invent custom group crypto (MLS lives in WS-S, §28.3).

**Acceptance criteria:**
- LCAP carries only ciphertext + opaque hints for private rooms; no plaintext/key/op-head/real-room-id ever enters an LCAP record/log/receipt.
- The carrier defers all key authority to WS-S; LCAP performs no group-key operations.
- A private-room member-removal stalemate (stale key epoch) renders the record clearly stale and never decrypts new content (§28.4 ↔ WS-S §10.9).

**Testing:** Unit — carrier parse; "no plaintext/key egress" assertion; stale-epoch labelling. Cross-ref — WS-S envelope conformance.

**Dependencies:** WS-R.2.1, WS-R.11.5.

---

## WS-R.17 Client surface, trust labels, and operational modes

### WS-R.17.1 Honest trust/liveness badges
**ID:** WS-R.17.1 | **Ref:** OFFLINE_SPEC §34, §18.2, §20.1

**Description:** Implement `apps/web/src/lcap/trustBadges.tsx` rendering the §34 honest labels mapped from trust state (§18.2) and liveness state (§20.1) — "Saved on this device", "Queued for sync", "Shared in exported bundle", "Stored by nearby relay", "Received by Licio server", "Accepted by room", "Included in room checkpoint", "Witnessed by independent watcher", "Verified locally, but checkpoint is stale", "Cannot verify yet: missing key/capability", "Conflict detected", "Revoked", "Rejected by room policy". The UI MUST NOT collapse states into one badge and avoids *secure/trusted/delivered/final/safe* unless the exact meaning is shown.

**Acceptance criteria:**
- Each trust/liveness state maps to its honest label; no single "verified"/"delivered" badge exists.
- Stale/provisional/conflict/revoked/rejected states are visually distinct and explained.
- Labels are i18n-catalog entries (locale-ready) and pass the prohibited-language scan.

**Testing:** Unit — state→label mapping completeness. E2E (axe) — each badge state renders accessibly with no forbidden wording.

**Dependencies:** WS-R.8.1, WS-R.10.1.

---

### WS-R.17.2 Operational modes
**ID:** WS-R.17.2 | **Ref:** OFFLINE_SPEC §33

**Description:** Implement the §33 operational modes — Minimal (C0+T1, no media prefetch, aggressive GC), Standard (C0+T1+selected E2, thumbnails, saved/subscribed snapshots), Courier (opt-in public C0/T1/E2 replication, larger cache, battery/storage warnings, no private by default), Relay (operator-controlled), Stealth/high-risk (no auto discovery/advertising, manual-only, generic filenames, small cache, clear trust warnings), Emergency text (text/control only, all media off, P0/P1 only, one-tap export of a selected public emergency thread, QR checkpoint/revocation). Mode selection drives budgets (WS-R.6.2) and storage (WS-R.11.2).

**Acceptance criteria:**
- Each mode applies its budget/prefetch/GC/discovery policy; Emergency disables all media and limits to P0/P1.
- Stealth disables discovery/advertising/background sync and uses generic filenames.
- Mode is user-selectable and persisted; high-risk modes show clear trust warnings.

**Testing:** Unit — per-mode policy application. E2E — mode switch + emergency one-tap export.

**Dependencies:** WS-R.11.2, WS-R.6.2.

---

### WS-R.17.3 Outbox / quarantine / conflict UI states
**ID:** WS-R.17.3 | **Ref:** OFFLINE_SPEC §14.7, §25, §34

**Description:** Implement the user-journey states for outbox (queued/retrying/exported), quarantine (missing-dependency with a "fetch what's missing" action), and conflict (device-fork / checkpoint-fork severe warnings with inspection, never silent discard). Each state has empty/loading/success/error/offline/safety/a11y variants per the Section 30.8 client sizing rule.

**Acceptance criteria:**
- Outbox/quarantine/conflict each render all journey states accessibly (WCAG 2.2 AA).
- A quarantined item exposes its missing deps and a retry action; a fork shows a severe, inspectable warning.
- No state implies trust the projection has not granted.

**Testing:** E2E (Playwright + axe) — each state; quarantine→resolve; fork-warning inspection.

**Dependencies:** WS-R.17.1, WS-R.4.3, WS-R.13.1.

---

## WS-R.18 Testing, simulation, and acceptance

### WS-R.18.1 Deterministic test-vector corpus
**ID:** WS-R.18.1 | **Ref:** OFFLINE_SPEC §32.1

**Description:** Assemble the canonical `packages/lcap/src/test-vectors/` corpus: LDC encoding, record/proof/block CID computation, ES256 low-S verification, a rejected high-S signature, detached-proof domain separation, pack parsing, chunk verification, and checkpoint inclusion + consistency proofs. Each vector pins logical value → bytes → CID/signature and is replayed in CI; altering a vector is a breaking change.

**Acceptance criteria:**
- Every listed vector exists and is asserted both directions where applicable.
- The corpus is the normative pin for determinism (referenced by WS-R.0.2c/0.3/0.6a/0.6b and WS-R.9.2/9.3).

**Testing:** Unit — vector replay across the codec/CID/COSE/Merkle modules.

**Dependencies:** WS-R.0.6b, WS-R.9.3.

---

### WS-R.18.2 Property-test suite
**ID:** WS-R.18.2 | **Ref:** OFFLINE_SPEC §32.2

**Description:** Implement the §32.2 properties: same semantic record ⇒ same bytes; unknown critical fields fail closed; `record_cid` never depends on signature bytes; duplicate imports idempotent; malformed packs never render trusted; all visible records have dependency closure or a clear provisional label; C0 cannot be starved by M3/B4; outbox hard pins never GC'd; forked device sequence detected; checkpoint forks detected.

**Acceptance criteria:**
- All ten properties are encoded as property tests and pass.
- The C0-starvation and hard-pin properties align with the WS-R.5.4 / WS-R.10.3 gates.

**Testing:** Property tests (fast-check or equivalent) over generated records/packs/schedules.

**Dependencies:** WS-R.5.4, WS-R.8.3, WS-R.10.3.

---

### WS-R.18.3a Deterministic discrete-event network simulator engine
**ID:** WS-R.18.3a | **Ref:** OFFLINE_SPEC §32.3

**Description:** Build the seeded discrete-event simulation engine in `packages/lcap/src/test-vectors/sim/`: a virtual clock, a set of `SimNode`s each running the real LCAP client/server/relay logic over an in-memory transport, and a seeded PRNG driving the link model — random partitions, short contacts, asymmetric links, message loss, duplicate/replay delivery, wrong device clocks, and storage pressure. Adversarial node behaviors are pluggable strategies (malicious relay withholds/floods/lies; equivocating authority; compromised device key). The engine is fully deterministic from `(seed, scenario)` so any failure reproduces exactly, and it exposes hooks to sample the §32.3 metrics without touching attention/IP data.

**Acceptance criteria:**
- `run(seed, scenario)` is byte-reproducible; the same seed yields the identical event trace and outcomes.
- Nodes execute the REAL LCAP logic (no simulator-only shortcuts through validation/scheduling).
- Link/adversary behaviors are pluggable strategies; the engine emits the metric hooks but stores no raw attention/IP data.

**Testing:** Unit — seed reproducibility; real-logic-in-the-loop assertion; pluggable-adversary wiring.

**Dependencies:** WS-R.8.3, WS-R.9.4, WS-R.5.4.

---

### WS-R.18.3b Scenario library + delivery-metric assertions
**ID:** WS-R.18.3b | **Ref:** OFFLINE_SPEC §32.3, §38

**Description:** Build the scenario library and metric thresholds on top of WS-R.18.3a: the named scenarios (brief mobile window, manual ferry, clinic relay, checkpoint fork, key compromise, revocation race, all-media flood) and the captured metrics with asserted bounds — P0 propagation time, P1 text convergence, bytes per accepted record, outbox age, quarantine ratio, checkpoint freshness, fork-detection latency, media-starvation prevention, and battery/storage budget compliance. Equivocation/compromise scenarios MUST surface fork evidence / revocation as designed; media MUST never beat P0 to delivery.

**Acceptance criteria:**
- Each named scenario runs and asserts its metric bounds (e.g. P0 propagates ahead of media; fork detection within a bounded number of contacts).
- Equivocation surfaces gossiped fork evidence; a compromised key is contained at the next revocation contact.
- Metric thresholds map to the §38 risk register so a regression names the risk it reopens.

**Testing:** Simulation suite (node) — per-scenario metric assertions; seeded determinism; risk-register linkage.

**Dependencies:** WS-R.18.3a.

---

### WS-R.18.4 Security tests (fuzz, bombs, malleability, downgrade, replay)
**ID:** WS-R.18.4 | **Ref:** OFFLINE_SPEC §32.4

**Description:** Implement the §32.4 security suite: zip/pack bombs, CBOR duplicate keys, invalid lengths, nested manifests, signature malleability (high-S), unknown algorithms, downgrade attempts, replay attacks, revoked capabilities, capability quota overuse, import of private metadata into public mode, and malicious Markdown payloads routed through the existing Licio UGC sink (DOMPurify/Trusted Types). Includes a fuzz corpus over the pack reader.

**Acceptance criteria:**
- Every attack is rejected/quarantined with the correct status; none renders trusted content.
- The pack-reader fuzz corpus runs in CI; new crashers are added as regression fixtures.
- Private-metadata-into-public-export is blocked; UGC payloads are sanitized by the existing sink.

**Testing:** Security suite + fuzz; regression fixtures for any discovered crash.

**Dependencies:** WS-R.14.1, WS-R.0.8, WS-R.4.2.

---

### WS-R.18.5 Interoperability tests (browser ↔ Node)
**ID:** WS-R.18.5 | **Ref:** OFFLINE_SPEC §32.5

**Description:** Implement §32.5 interop: a record signed in the browser verifies in Node and vice versa; a bundle exported from one browser profile imports into another without semantic change. Runs in CI across the WebCrypto (browser/Playwright) and Node runtimes against the shared vector corpus.

**Acceptance criteria:**
- Cross-runtime sign/verify and bundle import/export round-trips pass.
- The shared corpus is the single source of truth for both runtimes.

**Testing:** Gated cross-runtime suite (Node unit + Playwright) over the WS-R.18.1 corpus.

**Dependencies:** WS-R.18.1, WS-R.15.1.

---

### WS-R.18.6 Acceptance gates, docs, index, version
**ID:** WS-R.18.6 | **Ref:** OFFLINE_SPEC §36; Documentation rules (CLAUDE.md)

**Description:** Wire the §36 acceptance gates as CI checks and a launch checklist (record_cid/proof separation; deterministic vectors stable; browser↔Node interop; malformed-pack fuzz; C0-starvation; outbox durability; revocation propagation; checkpoint consistency; reviewed UI trust labels; no raw attention/IP/location in LCAP schemas; low-end-Android storage-pressure behavior; import/export privacy warnings; external threat-model review; private-room replication disabled or separately audited; **and the elevated-transport gates — every transport funnels through the one `validate`/`LcapTransport` seam (no parallel trust path); the correctness-independent-of-transport property holds; no peer IP/multiaddr/radio identifier in any LCAP schema; the WebRTC/IPFS deps stay code-split + workspace-excluded so the < 200 KB initial-bundle and `apps/web` `<15` budgets hold; the IPFS public-only review gate is enforced; all P2P/courier reach is off by default and Stealth/Emergency-disabled; the `apps/courier` Capacitor native build is green**). In the same change set, add `docs/offline/README.md` (implementation reference), register WS-R in `docs/planning/00-index.md`, update the `CLAUDE.md`/`AGENTS.md` roadmap row (kept byte-identical), and bump the root `package.json` PATCH version. No `claude.ai/code/session_*` URL in any doc or PR body.

**Acceptance criteria:**
- Every §36 gate has a corresponding CI check or signed-off manual gate; the checklist is in the README.
- The master index lists WS-R accurately; `CLAUDE.md ≡ AGENTS.md` (empty `diff`); version bumped.
- High-risk use is documented as gated on external security review (no false "secure" claim).

**Testing:** `pnpm check:policy`; the CLAUDE.md ≡ AGENTS.md byte-identical assertion; the acceptance-gate CI suite.

**Dependencies:** all WS-R implementation cards (lands with them).

---

## Dependency graph (within WS-R)

```
R.0.1 ─ R.0.2a ─ R.0.2b ─ R.0.2c                          (LDC encoder → decoder → vectors)
R.0.2a ─┬─ R.0.3 ─┐                                        (CID)
        └─ R.0.4 ─┤                                        (AAD)
R.0.1 ─ R.0.5a ─ R.0.5b   ;   R.0.1 ─ R.0.8                (ECDSA core/keys ; suite registry)
R.0.3 + R.0.4 + R.0.5a ─ R.0.6a ─ R.0.6b   ;   R.0.8 ─ R.0.6b   (COSE build → verify; verify uses suites)
R.0.2b ─ R.0.7                                             (closed-schema zod)
R.0.6a/0.6b/0.7 ─ R.1.1 ─ R.1.2 ─ R.1.3 ─ R.1.4 ─ R.1.5    (identity/capability/revocation)
R.1.2 ─ R.2.1 ─ R.2.2 ; R.2.1 ─ R.2.3 ; R.2.1/R.1.3 ─ R.2.4
R.0.3 ─ R.3.1 ─ R.3.2 ; R.3.1 ─ R.3.3 ; R.0.3 ─ R.3.4
R.1.5 ─ R.7.2 ; R.5.1 + R.7.2 ─ R.5.2a ─ R.5.2b ─ R.5.2c   (closure → scheduler front → DRR → score/emit)
R.5.2c ─ R.5.3 (needs R.10.2) ; R.5.2b + R.5.2c ─ R.5.4
R.0.2a/0.3/0.7 ─ R.4.1 ─ R.4.2 ─ R.4.3 ; R.4.1 ─ R.4.4     (pack writer takes a caller-provided order)
R.6.1 ─ R.6.2 ─ R.6.3 ; R.6.2 ─ R.6.4 ; R.6.2/R.2.4 ─ R.6.5
R.6.1/R.1.4 ─ R.7.1 ─ R.7.3
R.1.4/R.1.5 ─ R.8.1 ─ R.8.2a ─ R.8.2b ─ R.8.2c ─ R.8.3     (validate: integrity → authority → consensus)
R.12.2 ─ R.9.1 ─ R.9.2 ─ R.9.3 ─ R.9.4                     (room log → Merkle/checkpoint → proofs → witness)
R.12.2 ─ R.12.1a ─ R.12.1b (←R.8.2c) ─ R.12.1c (←R.9.1, R.12.3, R.10.2)   ;   R.12.2 ─ R.12.3
R.12.1c/R.6.2/R.9.3 ─ R.12.4
R.10.2 ─ R.10.1 ; R.11.3 ─ R.10.3
R.11.3 ─ R.11.1 ─ R.11.2 ─ R.11.4 ; R.2.1/R.1.2 ─ R.11.5
R.8.2c/R.2.4/R.9.4 ─ R.13.1 ─ R.13.2
R.4.2 ─ R.14.1 ; R.6.3/R.4.4 ─ R.14.2 ; R.0.7 ─ R.14.3 ; R.0.7 ─ R.14.4
R.4.* ─ R.15.1 ; R.6.1 ─ R.15.2 ; R.12.4/R.14.4 ─ R.15.3
R.15.1/R.11.4 ─ R.15.4a ─ R.15.4b ─ R.15.4c ─ R.15.4d ; R.15.4b ─ R.15.4e ; R.15.4d/R.15.4e/R.18.3a ─ R.15.4f   (Capacitor courier)
R.12.4 ─ R.15.5 (WebTransport) ; R.15.4b/R.12.4 ─ R.15.6a ─ R.15.6b ; R.15.6a ─ R.15.7a ─ R.15.7b   (WebRTC ; Helia IPFS bridge)
R.15.6a/R.15.7a ─ R.15.8 (budget+egress gate) ; R.15.5/R.15.6b/R.15.7b/R.18.3a ─ R.15.9 (transport sim/interop)
R.2.1/R.11.5 ─ R.16.1  (bridge to WS-S)
R.8.1/R.10.1 ─ R.17.1 ─ R.17.3 ; R.11.2/R.6.2 ─ R.17.2
R.0.6b/R.9.3 ─ R.18.1 ; R.5.4/R.8.3/R.10.3 ─ R.18.2 ; R.8.3/R.9.4/R.5.4 ─ R.18.3a ─ R.18.3b
R.14.1/R.0.8/R.4.2 ─ R.18.4 ; R.18.1/R.15.1 ─ R.18.5 ; (all) ─ R.18.6
```

The graph is acyclic. Three cycles present in earlier cuts were removed: the pack writer (R.4.1) now takes a **caller-provided** object order rather than build-depending on the scheduler (R.5.2c); the room-log append (R.9.1) is a DB primitive that the ingestion commit stage (R.12.1c) *calls* rather than the reverse; and the relay quota policy (R.14.4) is standalone (depends only on the schemas R.0.7) while the relay service (R.15.3) *consumes* it — the first cut had R.14.4↔R.15.3 mutually depending. The dependency-closure helper (R.7.2) is scheduler-independent and feeds R.5.2a. The **elevated transports keep the graph acyclic**: the shared `LcapTransport` seam (R.15.4b) depends only on the validated core (R.4.2/R.5.2c/R.8.3) and is *consumed* by the courier (R.15.4c–f), WebRTC (R.15.6a), and WebTransport (R.15.5); the IPFS bridge (R.15.7a) rides the WebRTC P2P groundwork (R.15.6a) and the CID/block layer (R.0.3/R.3.1); and R.15.4f/R.15.9 depend on the simulator (R.18.3a), which depends on the core (R.8.3/R.9.4/R.5.4), never on any R.15 transport — so there is no back-edge from the transports into the simulator.

Cross-stream order: **R.0** (LDC codec → CID → AAD → ECDSA → COSE → schemas → suites) is the gate for everything. Then **R.1** (identity/capabilities/revocations) and **R.2/R.3** (records/blocks) in parallel; **R.5** (closure → scheduler front → DRR → score) and **R.4** (pack) co-develop but are decoupled (the writer consumes the scheduler's emitted order at integration in R.15.1); **R.6/R.7/R.8** (sync/reconciliation/trust) build on records + scheduler; **R.9** (checkpoints) sits on the server **R.12** DB; **R.10/R.11** (liveness/storage) underpin the client; **R.13/R.14** (conflict/privacy-DoS) harden; **R.15** (the now-elevated transports — manual bundle/QR/relay **plus** the first-class WebTransport, WebRTC P2P, browser-IPFS bridge, and native Capacitor courier) and **R.16** (private bridge) and **R.17** (UI) ride the validated core; **R.18** (tests/sim/acceptance) runs continuously and gates the close. The phase mapping to OFFLINE_SPEC §35 (correspondingly de-deferred in the spec) is: Phase 0 = R.0; Phase 1 = R.1/R.6/R.11/R.12; Phase 2 = R.3/R.4/R.5/R.15.1–2; Phase 3 = R.9/R.10; **Phase 4 = R.15.3 (relay) + R.15.5 (WebTransport)**; **Phase 5 = R.15.4a–f (native Capacitor courier) + R.15.6a/b (WebRTC P2P)**; **Phase 6 = R.15.7a/b (browser-IPFS public bridge) + R.15.8 (transport budget/egress gate) + R.15.9 (transport simulation/interop) + R.7.3/R.16/witness hardening/PQ reservation**. Because the transports depend on the validated core, "elevated priority" pulls the *workstream* earlier (Wave 8) and makes these transports **required, not optional** — it does not reorder them ahead of R.0–R.14, which they require by construction.

## Milestone gate additions

| Gate | Cards | Requirement |
|---|---|---|
| Record/proof separation | R.0.3, R.0.6a, R.18.2 | `record_cid` is independent of signature bytes; multi-proof never changes identity. |
| Deterministic encoding | R.0.2a, R.0.2c, R.18.1 | LDC vectors stable; same logical value ⇒ identical bytes; closed-schema unknown-field rejection. |
| Crypto interop | R.0.5a, R.0.5b, R.18.5 | Browser↔Node ES256 low-S sign/verify and bundle round-trip pass. |
| No transport trust | R.8.2c, R.8.3 | Every ingress funnels through the single `validate`; hostile relay ≡ trusted friend in trust state. |
| C0 cannot starve | R.5.2b, R.5.4 | C0 reservation precedes DRR; `check:lcap-scheduler` proves control/dependency closure never preempted by media/bulk. |
| Outbox durability | R.10.3 | Hard pins survive eviction; signed-unsent records retry on every opportunity. |
| Revocation propagation | R.1.4, R.7.1 | Revocations are P0/C0, reconciled before content; stale frontiers labelled. |
| Checkpoint consistency | R.9.2, R.9.3, R.9.4 | Inclusion/consistency verify (RFC 9162-compatible); equivocation → gossiped fork evidence. |
| LCAP doctrine | R.14.3 | No raw attention/IP/location/applause field in any LCAP schema; gates in CI. |
| Honest UI | R.17.1 | No single "verified"/"delivered" badge; provisional/stale/conflict/revoked/rejected explicit. |
| Malformed-pack safety | R.4.2, R.14.1, R.18.4 | Bombs/forks/downgrade/replay rejected; nothing renders before trust projection. |
| Transports first-class | R.15.4a–f, R.15.5, R.15.6a/b, R.15.7a/b, R.15.9 | Native Capacitor courier + WebTransport + WebRTC P2P + browser-IPFS public bridge ship as **required** transports reusing the same packs / `validate` / scheduler; the correctness-independent-of-transport property holds (any transport subset, HTTPS-only included, reaches the identical accepted set + trust state). |
| Transport privacy + budget | R.15.4e, R.15.6b, R.15.7b, R.15.8 | No peer IP / multiaddr / radio identifier in any LCAP schema (`check:lcap-schema-egress` over `@licio/lcap-p2p` + `apps/courier`); the P2P deps are workspace-excluded + separately code-split (the `<15` web budget and < 200 KB initial-bundle gate hold); IPFS publishes public blocks only behind the review gate; all P2P/courier reach is off by default and Stealth/Emergency-disabled. |
| Docs byte-identical | R.18.6 | CLAUDE.md ≡ AGENTS.md; README + index updated; version bumped; no session URL. |

## Definition of done (workstream)

- LCAP records are identified by the deterministic body hash only; signatures are detached COSE_Sign1 proofs; `record_cid` is independent of proof bytes, pinned by conformance vectors that pass in browser and Node.
- The full trust pipeline — device certificate → capability → device proof → revocation knowledge → checkpoint inclusion/consistency → witnesses — is implemented; **every** ingress (HTTPS, manual bundle, QR, relay, WebTransport, WebRTC P2P, browser-IPFS bridge, native Capacitor courier) funnels through the single shared `validate(record_cid)` via one `LcapTransport` seam, and the path of arrival never confers trust.
- The lane scheduler guarantees C0/dependency closure can never be starved by media/bulk, proven by the named `check:lcap-scheduler` gate and the §32.2 property suite; the durable outbox hard-pins local material against eviction.
- Server ingestion quarantines before commit, accepts idempotently by `record_cid`, appends topologically to the room log, issues signed receipts, and exposes the §29 endpoints with the §22.1.1 HTTP status mapping; the `lcap_v2` IndexedDB and the new `lcap_*` Postgres tables coexist with the shipped stores without migration of either.
- Manual `.licio-bundle` export/import is a first-class transport with full privacy disclosure; QR micro-bundles carry C0 control material; the untrusted relay can store/serve/receipt but never accept; and — per the 2026-06 maintainer decision — the **native Capacitor courier (Nearby Connections / Wi-Fi Direct / Bluetooth / hotspot / USB), WebTransport (HTTP/3), WebRTC browser↔browser P2P, and the browser-IPFS/libp2p public-block bridge are all shipped, first-class transports** (not deferrals): each reuses the same packs and the single trust path, is off by default and consent-gated per mode (Stealth/Emergency-disabled), exposes no transport-layer metadata into any LCAP schema, and confines its dependencies to the code-split `@licio/lcap-p2p` workspace package or the `apps/courier` native shell so the web `<15` dep budget and the < 200 KB initial-bundle gate hold; the IPFS bridge publishes public blocks only behind a required privacy/moderation/abuse-review gate.
- Private-room content is carried as ciphertext + opaque hints only; LCAP owns no group-key authority (that is WS-S / PRIVATE_SPEC §10), and no plaintext/key/op-head/real-private-room-id ever enters an LCAP record, log, or receipt.
- The UI exposes trust and liveness as distinct, honest, accessible states (WCAG 2.2 AA), never collapsing them into one badge and never using *secure/trusted/delivered/final/safe* without exact meaning; the six operational modes (incl. Emergency text and Stealth) apply their budget/discovery policies.
- The deterministic-vector, property, network-simulation, security/fuzz, and browser↔Node interop suites pass; the §36 acceptance gates are wired in CI; high-risk/private-room use is documented as gated on external security review.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm lint:security`, `pnpm check:deps`, `pnpm check:workspace-deps`, `pnpm check:no-applause`, `pnpm check:no-raw-egress`, `pnpm check:lcap-schema-egress`, `pnpm check:lcap-scheduler`, `pnpm check:sw`, and `pnpm check:policy` all pass; the web LCAP core **and** the `@licio/lcap-p2p` WebRTC/IPFS transport chunk are code-split (the < 200 KB initial-bundle gate and the `apps/web` `<15` direct-production-dep budget both hold, with `@licio/lcap-p2p` registered in `scripts/check-workspace-deps.ts`); the `apps/courier` Capacitor native build is green in CI; docs are updated in the same change set and the PATCH version is bumped.
