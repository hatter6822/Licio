# WS-R: Offline Content Availability (LCAP v0.2)

**Milestone:** Post-M3 resilience extension (lands after the WS-Q content model; not launch-blocking for the core social product) | **Priority:** P3 | **Dependencies:** WS-C (PWA shell, offline/IndexedDB, service worker), WS-D (account authority, device keys, sessions), WS-E (event/topic registry, attention doctrine), WS-F (stories/sources), WS-G (forum/rooms), WS-Q (room-owned content + visibility) — all complete | **Source spec:** `docs/OFFLINE_SPEC.md` (LCAP v0.2) | **Wave:** 10 (parallelizable with WS-S after WS-R.0) | **Estimated duration:** 12-16 weeks | **Task count:** 77 atomic cards

---

## Overview

WS-R implements **LCAP v0.2 — the Licio Content Availability Protocol** (`docs/OFFLINE_SPEC.md`): a delay-tolerant, content-addressed, signed synchronization protocol that lets Licio content stay creatable, verifiable, transferable, and reconcilable under intermittent connectivity, hostile networks, cheap old phones, and incomplete trust. LCAP optimizes **useful verified availability per cost** (OFFLINE_SPEC §1), not raw bandwidth, and guarantees that tiny trust/liveness objects always move before media.

LCAP is organized as four planes (OFFLINE_SPEC §8):

    record plane     deterministic record bodies → record_cids; blocks → block_cids
    trust plane      detached proofs · device certs · capabilities · revocations · checkpoints · witnesses
    sync plane       pulse + exchange · anti-entropy · lane scheduler · liveness state machine · receipts
    transport plane  HTTPS · manual .licio-bundle · QR · local relay · (future) Android courier

The baseline MUST work inside the existing PWA using HTTPS, service workers, IndexedDB, WebCrypto, and ordinary file import/export (OFFLINE_SPEC §3.1). Manual `.licio-bundle` transfer is a first-class transport, not a fallback. Native radio transports are optional and gated.

LCAP is **almost entirely net-new code** in three new locations plus a new DB schema file; it touches the running app only at well-defined seams (service-worker hooks, a sibling IndexedDB database, the no-raw-egress/no-applause CI gates, and read-only reuse of WS-D device identity). It does **not** modify the WS-E attention pipeline, the WS-I ranking math, or any existing wire schema.

### New and touched modules (verified against the shipped tree)

| Concern | Module / file | WS-R change |
|---|---|---|
| Pure protocol library | `packages/lcap/` (new) | deterministic CBOR (LDC), CID, COSE detached proof, zod schemas, validate/trust projection, streaming pack, lane scheduler, sync state machine, test vectors (OFFLINE_SPEC §31) |
| Web integration | `apps/web/src/lcap/` (new) | `lcap_v2` IndexedDB, outbox/signing, pulse/exchange/fetch orchestration, streaming bundle export/import, trust/liveness badges, storage policy |
| Server integration | `apps/api/src/lcap/` (new) | Hono `/api/lcap/v2/*` routes, pack ingestion, proof/capability/revocation verify, room-log reconcile, Merkle checkpoints, receipt emission |
| Database | `packages/db/src/schema/lcap.ts` (new) + migrations | `lcap_records`, `lcap_proofs`, `lcap_blocks`, `lcap_chunks`, `lcap_device_certs`, `lcap_capabilities`, `lcap_capability_usage`, `lcap_revocations`, `lcap_room_log`, `lcap_room_checkpoints`, `lcap_receipts`, `lcap_quarantine`, `lcap_fork_evidence` (OFFLINE_SPEC §30) |
| Local-DB coexistence | `apps/web/src/offline/db.ts` (`DB_NAME = 'licio'`) | none — LCAP uses a separate `lcap_v2` database (OFFLINE_SPEC §23.1); no migration of WS-C stores |
| Device identity | WS-D `webauthn-credential` / `wallet-auth-credential` / account authority | read-only reuse: the account authority signs `device_certificate` records; LCAP device keys are new, room-scoped signing keys (OFFLINE_SPEC §11) |
| Service worker | `apps/web/public/sw-push.js` + `sw-register.ts` | add C0-first sync-on-connectivity hook; no remote `importScripts`; respects data/battery/privacy mode (OFFLINE_SPEC §23.3); `check:sw` stays green |
| Crypto / compression primitives | WebCrypto `crypto.subtle`, Compression Streams | SHA-256 + ES256 + AES-256-GCM from the platform; gzip/deflate from the platform — **no new npm dependency** (OFFLINE_SPEC §31.1) |
| Privacy gates | `check:no-raw-egress`, `check:no-applause` | extended to scan `packages/lcap`, `apps/web/src/lcap`, `apps/api/src/lcap` (OFFLINE_SPEC §3.7) |
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
- **No new dependency; lazy-loaded.** LCAP uses WebCrypto + Compression Streams + IndexedDB; the deterministic-CBOR/COSE subset is hand-rolled in `packages/lcap` (§31.1). The web LCAP module is code-split so the initial-load bundle-size gate (< 200 KB gz) does not regress. `apps/web` MUST NOT import `@licio/db`.
- **Doctrine gates extended.** `check:no-raw-egress` and `check:no-applause` are extended to the new LCAP source trees; a new `check:lcap-schema-egress` asserts no IP/location/attention field name appears in any LCAP record/proof/receipt schema.
- **UI honesty (§34).** Trust and liveness are never collapsed into a single "verified"/"delivered" badge; the UI exposes provisional/stale/conflict/revoked/rejected states explicitly and avoids the words *secure/trusted/delivered/final/safe* unless the exact meaning is shown.
- **Task sizing (Section 30.8).** Every card is one deliverable — one schema, one codec, one verifier, one endpoint, one store, one client state — reviewable, testable, and reversible in ≤ 1-3 engineering days. Sub-area headers group cards; the dependency graph at the end fixes their order.

---

## WS-R.0 Foundations: deterministic encoding, CIDs, and the crypto profile

### WS-R.0.1 `packages/lcap` package scaffold
**ID:** WS-R.0.1 | **Ref:** OFFLINE_SPEC §31, §31.1

**Description:** Create the `@licio/lcap` workspace at `packages/lcap/` with the §31 source tree (`cbor/`, `cid/`, `cose/`, `schemas/`, `validate/`, `pack/`, `scheduler/`, `sync/`, `test-vectors/`), TypeScript strict config (`types: ["node"]`), a thin `vitest.config.ts` reusing `vitest.shared.ts`, and an SPDX header on every file. The package depends on `@licio/shared` only; it MUST NOT depend on `@licio/db`. Declare zero runtime npm dependencies — SHA-256/ECDSA/AES come from WebCrypto, compression from Compression Streams (§31.1).

**Acceptance criteria:**
- `pnpm --filter @licio/lcap build` and `pnpm --filter @licio/lcap test` run standalone.
- `pnpm check:workspace-deps` passes; `packages/lcap/package.json` declares no production dependency outside `workspace:*`.
- `pnpm check:deps` unaffected (web/api budgets unchanged); the package is excluded from the web direct-dep count.

**Testing:** Unit — a trivial export smoke test. CI — workspace-boundary and dep-budget gates green.

**Dependencies:** none (new leaf-ish package; depends on `@licio/shared`).

---

### WS-R.0.2 LDC deterministic CBOR codec + conformance vectors
**ID:** WS-R.0.2 | **Ref:** OFFLINE_SPEC §9.1

**Description:** Implement the LCAP Deterministic CBOR profile (LDC) in `packages/lcap/src/cbor/`: an encoder and a strict decoder over the closed grammar — major types 0–5 plus the three simple values, shortest-form integers, definite-length only, map keys sorted in ascending bytewise-lexicographic order of their encodings, duplicate-key rejection, no floats, no tags, no `undefined`, optional fields omitted (never `null`-filled), UTF-8/NFC text validation. The decoder rejects (does not normalize) any non-LDC input. Hand-rolled — no general CBOR dependency (§31.1).

**Acceptance criteria:**
- Round-trip identity for every supported logical value; two encoders produce byte-identical output.
- Decoder rejects: indefinite-length items, non-shortest integers, out-of-order/duplicate map keys, floats, tags, invalid UTF-8, non-NFC identifier text.
- A `test-vectors/cbor.json` corpus (logical value → hex) is committed and asserted both directions.

**Testing:** Unit — encode/decode/reject matrix; property test "same logical value ⇒ identical bytes"; vector replay.

**Dependencies:** WS-R.0.1.

---

### WS-R.0.3 CID construction (record/proof/block/chunk) + vectors
**ID:** WS-R.0.3 | **Ref:** OFFLINE_SPEC §9.2, §9.3, §9.4

**Description:** Implement `packages/lcap/src/cid/`: `cidFor(kind, bytes)` producing the §9.2 binary layout `0x01 || kind_code || 0x12 || 0x20 || sha256(bytes)` (kind_code: record `0x01`, proof `0x02`, block `0x03`, chunk `0x04`) and the string form `human_prefix || base32(cid_bytes)` (RFC 4648 §6 lower-case, no padding; prefixes `lcapr_`/`lcapp_`/`lcapb_`/`lcapc_`). Provide `parseCid` (validates prefix↔kind_code coherence, length, multihash bytes) and `verifyCid(cid, bytes)`. SHA-256 via `crypto.subtle.digest`.

**Acceptance criteria:**
- `record_cid` is computed over the deterministic record body only (never proof/framing/compression).
- `parseCid` rejects a string whose human prefix and binary `kind_code` disagree, wrong length, or non-`0x12/0x20` multihash.
- `test-vectors/cid.json` pins body→cid for each kind and is asserted.

**Testing:** Unit — construct/parse/verify/reject matrix; vector replay; cross-check that a record digest cannot be reparsed as a block CID.

**Dependencies:** WS-R.0.2.

---

### WS-R.0.4 Domain separation + `external_aad` builder
**ID:** WS-R.0.4 | **Ref:** OFFLINE_SPEC §9.5, §10.2.2

**Description:** Implement `packages/lcap/src/cose/aad.ts`: `domainSeparator(network_id, object_kind, purpose)` producing the §9.5 grammar string (`LCAP-v0.2:<net>:<kind>:<purpose>`, validated against the allowed token sets) and `buildExternalAad({ separator, protocol_version, network_id, record_kind, proof_kind })` returning the LDC encoding of the fixed-shape array (§10.2.2). The separator is only ever carried as the first array element, never hand-concatenated with payload bytes.

**Acceptance criteria:**
- `buildExternalAad` output is byte-stable and equals a committed vector.
- Separator grammar rejects illegal `object_kind`/network tokens.
- A mismatched `network_id`/`record_kind`/`proof_kind` produces a different AAD (and therefore a non-verifying signature downstream).

**Testing:** Unit — grammar accept/reject; AAD byte-stability vector; differential test that any field change perturbs the bytes.

**Dependencies:** WS-R.0.2.

---

### WS-R.0.5 ES256 low-S sign/verify + browser↔Node interop vectors
**ID:** WS-R.0.5 | **Ref:** OFFLINE_SPEC §10.1, §10.1.1

**Description:** Implement `packages/lcap/src/cose/ecdsa.ts` over WebCrypto `ECDSA P-256/SHA-256`: `sign` normalizes to low-S (`s := n − s` when `s > n/2`) and emits raw `r||s` (64 bytes); `verify` rejects (`rejected_high_s_signature`) unless `0 < r < n` and `0 < s ≤ n/2`, rejects DER, `r=0`/`s=0`, and `r,s ≥ n`. Keys are non-extractable `CryptoKey`s where supported (§10.5). Ship interop vectors proving a signature made in the browser verifies in Node and vice versa.

**Acceptance criteria:**
- High-S, DER-wrapped, zero, and out-of-range signatures are all rejected; only canonical low-S raw `r||s` verifies.
- Browser-generated and Node-generated vectors cross-verify (§32.5).
- Private keys are non-extractable where the runtime supports it; `exportKey` of a private key rejects.

**Testing:** Unit — canonicalization + rejection matrix; gated cross-runtime interop vector replay.

**Dependencies:** WS-R.0.1.

---

### WS-R.0.6 COSE_Sign1 detached proof build/verify
**ID:** WS-R.0.6 | **Ref:** OFFLINE_SPEC §10.2, §10.2.3, §10.2.4

**Description:** Implement `packages/lcap/src/cose/sign1.ts`: build the protected header (`{1: -7}` for ES256), assemble `Sig_structure = ["Signature1", cose_protected, external_aad, deterministic_record_body]`, `ToBeSigned = LDC(Sig_structure)`, and sign/verify with WS-R.0.5. Verification follows §10.2.4 exactly: recompute and match `record_cid`; reject absent/unknown/downgraded alg from the **protected** header; rebuild and byte-match `external_aad`; verify low-S; verify ECDSA. The algorithm lives only in the protected header.

**Acceptance criteria:**
- A valid detached proof over a record body verifies; flipping any of body / alg / AAD / signature fails with the correct status code.
- Stripping the alg or moving it to the unprotected header is rejected (no downgrade, §10.3).
- One record body carries multiple proofs (device + witness) without changing `record_cid`.
- `test-vectors/sign1.json` (body + key → proof) committed and replayed.

**Testing:** Unit — build/verify happy path + six tamper cases; multi-proof identity; vector replay.

**Dependencies:** WS-R.0.3, WS-R.0.4, WS-R.0.5.

---

### WS-R.0.7 Closed-schema zod records and proofs
**ID:** WS-R.0.7 | **Ref:** OFFLINE_SPEC §9.1.4, §10.2, §12.1

**Description:** In `packages/lcap/src/schemas/` define strict (`.strict()`) zod schemas for the §4.1 type aliases and every record/proof body (`DetachedProofV2`, `DeviceCertificateRecordV2`, `CapabilityRecordV2`, `RevocationRecordV2`, `ContributionEventRecordV2`, block/chunk descriptors). Unknown keys are rejected (`rejected_bad_schema`); forward compatibility is via `record_version` bump only. Each schema's parse is paired with LDC decode so wire bytes and the validated object cannot diverge.

**Acceptance criteria:**
- Every record/proof schema rejects unknown keys and missing required fields with a field-named error.
- `record_version`/`proof_version` mismatches route to the version-specific schema or reject.
- Schemas are the single normative source; the TypeScript sketches in the spec are illustrative.

**Testing:** Unit — accept/reject matrix per schema; unknown-field rejection; `expectTypeOf` inference checks.

**Dependencies:** WS-R.0.2.

---

### WS-R.0.8 Algorithm agility + downgrade protection
**ID:** WS-R.0.8 | **Ref:** OFFLINE_SPEC §10.3, §10.4

**Description:** Centralize suite negotiation in `packages/lcap/src/cose/suites.ts`: a `CryptoSuiteId` registry (`ES256` enabled; `Ed25519` reserved/disabled) with a fail-closed resolver that rejects unknown algorithms and forbids accepting a weaker/disabled suite because a peer omitted the stronger one. Reserve COSE alg ids and schema space for a future classical+PQ hybrid proof over the same `record_cid` (§10.4) without changing record identity.

**Acceptance criteria:**
- An unknown or disabled alg fails closed unless the record is explicitly handled as an opaque untrusted object.
- A node supporting ES256 (+future Ed25519) never downgrades when a peer advertises fewer suites.
- The hybrid-proof reservation is documented and a schema placeholder exists; enabling it does not alter `record_cid`.

**Testing:** Unit — negotiation/downgrade matrix; reserved-id placeholder test.

**Dependencies:** WS-R.0.6.

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

**Dependencies:** WS-R.0.6, WS-R.0.7.

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

**Dependencies:** WS-R.1.1, WS-R.1.2, WS-R.1.3, WS-R.1.4, WS-R.0.6.

---

## WS-R.2 Event records and the record graph

### WS-R.2.1 Contribution event record + WS-G/WS-Q mapping
**ID:** WS-R.2.1 | **Ref:** OFFLINE_SPEC §12.1; WS-G §15.2; WS-Q §14.5

**Description:** Implement the `contribution_event` record. Its `event_type` set and `licio_contribution_type` map onto the shipped WS-G eleven-type taxonomy; `home_room_id` + `visibility_scope` map onto the WS-Q room/visibility model (`public|in_room|private`). It references `capability_cid`, `policy_epoch_claim`, `revocation_epoch_claim`, optional `parent_record_cids`/`replaces_record_cid`/`thread_root_cid`, optional `body_block_cid`/`attachment_manifest_cid`/`source_snapshot_cids`, a `client_nonce`, a `priority`, and `privacy_flags`. Body text lives in a block, never inline (so normalization never perturbs `record_cid`).

**Acceptance criteria:**
- The schema accepts every WS-G contribution type and rejects unknown ones; `visibility_scope` aligns with WS-Q values.
- Body/attachments are block references; the record body itself is identifier-bearing only.
- `privacy_flags` (`contains_private_room_metadata`/`safe_for_unknown_relay`/`safe_for_manual_export`) are present and consulted by export/replication (WS-R.14).

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

**Description:** Implement `packages/lcap/src/pack/writer.ts` producing the §14.3 layout: magic `LCAPACK2\n`, LDC `PackHeaderV2`, LDC `PackTableV2` (object table **before** frames so a receiver can decide to import/skip/range-fetch), then `PackFrameV2`s, optional trailer. The writer streams (bounded memory), emits the table in transfer order from the scheduler (WS-R.5), and labels privacy (`privacy_label`) and lanes.

**Acceptance criteria:**
- Output starts with the magic, then header, then table, then frames; table precedes frames.
- Memory stays bounded for large packs (streamed, not buffered whole).
- Transfer order matches the scheduler decision; `contains_lanes`/`critical_cids` are populated.

**Testing:** Unit — byte-layout assertion; streaming memory bound; table-before-frames invariant.

**Dependencies:** WS-R.0.2, WS-R.0.3, WS-R.5.2.

---

### WS-R.4.2 Streaming pack reader (bounded memory)
**ID:** WS-R.4.2 | **Ref:** OFFLINE_SPEC §14.3, §14.6, §27.1

**Description:** Implement `packages/lcap/src/pack/reader.ts`: verify magic, parse header/table under resource caps (max pack/header/table/frame/uncompressed sizes, max entries, max dep depth/fan-out), then stream frames verifying each (`frame length ≤ cap`, payload hash matches CID, schema valid, proof matches `record_cid`, deps known-or-declared-missing, critical fields understood, privacy policy permits). Nothing is trusted before trust projection (WS-R.8).

**Acceptance criteria:**
- Every §14.6 frame check is enforced; a frame failing any check is rejected/quarantined, not rendered.
- All §27.1 caps are honored; an oversized header/table/frame aborts early with the right status.
- Parsing is streaming and bounded; a 0-byte or truncated pack fails cleanly.

**Testing:** Unit — frame-check matrix; cap enforcement; truncated/oversized pack handling. Security — fuzz corpus (WS-R.18.4).

**Dependencies:** WS-R.4.1, WS-R.0.6, WS-R.0.7.

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

**Dependencies:** WS-R.4.1, WS-R.0.6.

---

## WS-R.5 Lane scheduler and budgets

### WS-R.5.1 Lane/priority model + byte reservations
**ID:** WS-R.5.1 | **Ref:** OFFLINE_SPEC §15.1, §15.1.1, §15.3

**Description:** Implement the lane model (`C0|T1|E2|B4` per the §15.1.1 canonical `priority↔lane` table) and the §15.3 byte reservations (C0 first 8 KiB then ≥25%; T1 ≥40% after C0 minimum; E2 ≤25%; M3 ≤10% unless media explicitly requested; B4 0% by default). Implement the small-session ladder (≤8/32/128/512 KiB tiers). Lane is a default; an object MAY ship in a non-default lane when closure requires, but only genuine P0 trust/liveness material may enter C0.

**Acceptance criteria:**
- The canonical mapping table is the single source; `priority n`, `Pn`, and the lane agree.
- Reservations hold for every budget; a tiny (≤8 KiB) session carries only C0 material.
- Non-P0 material can never be promoted into C0.

**Testing:** Unit — reservation math across budgets; small-session ladder; C0-purity assertion.

**Dependencies:** WS-R.0.7.

---

### WS-R.5.2 Dependency-aware deficit-round-robin scheduler
**ID:** WS-R.5.2 | **Ref:** OFFLINE_SPEC §15.4

**Description:** Implement the §15.4 scheduler: build the candidate set (wants/interests/outbox/missing deps), remove privacy/budget/capability-forbidden objects, **promote missing dependencies of selected objects**, assign lane+score, reserve C0 bytes, run deficit round robin with lane weights, within a lane use shortest-verifiable-object-first with deadline boost, stop before budget overflow, emit the pack table in transfer order. The score factors are clamped to strictly-positive finite ranges (or computed log-additively) so no single zero factor un-schedules an object; C0 + dependency closure cannot starve regardless of weights.

**Acceptance criteria:**
- Dependencies of every selected object are promoted ahead of it.
- The scheduler never overflows the budget and always emits a valid transfer order.
- Score factors are clamped; scoring only breaks intra-lane ties after reservations + dependency promotion.

**Testing:** Unit — dependency promotion; budget-stop correctness; clamped-score finiteness; deterministic order for fixed input.

**Dependencies:** WS-R.5.1, WS-R.4.1.

---

### WS-R.5.3 Scarcity boost + user-pin override
**ID:** WS-R.5.3 | **Ref:** OFFLINE_SPEC §15.5, §15.6

**Description:** Implement the scarcity boost (objects with fewer known replicas — from receipt hints, not trusted proofs — score higher) and the user-pin override (pinned content MAY override normal lane weights **after** C0 obligations are satisfied). Replica count derives from distinct recent receipts for a `record_cid`/`block_cid`.

**Acceptance criteria:**
- Scarcer objects receive a higher scarcity weight; receipts are hints only and never bypass validation.
- User-pinned content outranks ambient cache but never preempts C0 obligations.

**Testing:** Unit — scarcity monotonicity in replica count; pin-after-C0 ordering.

**Dependencies:** WS-R.5.2, WS-R.10.2.

---

### WS-R.5.4 C0-starvation + dependency-closure CI gate
**ID:** WS-R.5.4 | **Ref:** OFFLINE_SPEC §15.2, §32.2

**Description:** Add `pnpm check:lcap-scheduler` (wired into CI) asserting the two scheduler invariants as named gates: **C0 cannot be starved by M3/B4** across adversarial candidate mixes, and **a dependent object is never sent before the dependencies needed to verify/render it**. Includes worst-case fixtures (all-media flood, dependency-bomb shapes within caps).

**Acceptance criteria:**
- The gate fails if any candidate mix lets media/bulk preempt schedulable C0.
- The gate fails if any emitted order places a dependent before a required dependency.
- The gate runs in CI on every PR touching `packages/lcap/src/scheduler`.

**Testing:** The gate itself (property + fixture suite); CI wiring.

**Dependencies:** WS-R.5.2.

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

**Dependencies:** WS-R.6.1, WS-R.5.2.

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

**Description:** Implement `minimalClosure(record)` returning the minimal trust/render closure for a renderable contribution — device cert + authority proof, capability + authority proof, contribution + device proof, body text block, parent/root records where needed for context, and the latest known room-checkpoint summary. Large media and old ancestor context are omitted unless explicitly requested.

**Acceptance criteria:**
- The closure is sufficient to reach `authorized_provisional` (or better) for the target without media.
- Old ancestors / large media are excluded by default and only added on explicit want.
- Closure interacts with the scheduler so dependencies precede dependents (WS-R.5.2).

**Testing:** Unit — closure minimality; sufficiency for trust projection; omission of media/ancestors.

**Dependencies:** WS-R.1.5, WS-R.5.2.

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

### WS-R.8.2 Validation algorithm (`validate(record_cid)`)
**ID:** WS-R.8.2 | **Ref:** OFFLINE_SPEC §18.3

**Description:** Implement the §18.3 fifteen-step `validate(record_cid)`: load body → verify CID → strict schema (reject unknown critical) → load proofs → verify ≥1 applicable proof → load signer key + device cert → verify cert authority proof → load capability → verify capability authority proof → check operation/scope/room/visibility/policy/quotas → check revocations → check device-sequence/fork → check checkpoint inclusion if available → check checkpoint consistency if available → return trust state + missing deps. This is the single entry point both client and server call.

**Acceptance criteria:**
- The algorithm runs the steps in order and returns `(trust_state, missing_cids)`; no step is skippable.
- Client and server share the identical implementation (one in `packages/lcap/src/validate/`).
- Each failure routes to the precise status code (`rejected_*`/`quarantined_*`/`conflicting`/`revoked`).

**Testing:** Unit — per-step success/failure; client≡server output on shared fixtures; missing-deps reporting.

**Dependencies:** WS-R.8.1, WS-R.2.4, WS-R.9.3.

---

### WS-R.8.3 No-transport-trust enforcement
**ID:** WS-R.8.3 | **Ref:** OFFLINE_SPEC §18.4, §32.2

**Description:** Enforce structurally that the path of arrival never confers trust: every ingress (HTTPS, manual bundle, QR, relay, courier) funnels through `validate(record_cid)` before anything renders. Add a property test "malformed packs never render trusted content" and "a record from a hostile relay and from a trusted friend yield identical trust state." Human trust may gate import willingness only.

**Acceptance criteria:**
- No render path exists that bypasses `validate`; an import source field never appears in the trust computation.
- The two property tests pass; a malformed/hostile pack reaches at most `quarantined_*`/`rejected_*`.

**Testing:** Unit/property — source-independence of trust state; no-render-before-validation; malformed-pack property.

**Dependencies:** WS-R.8.2, WS-R.4.2.

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

**Dependencies:** WS-R.12.1.

---

### WS-R.9.2 Merkle tree + checkpoint record
**ID:** WS-R.9.2 | **Ref:** OFFLINE_SPEC §19.1.1, §19.2

**Description:** Implement the §19.1.1 Merkle tree with RFC 6962/9162 domain-separated hashing — empty `= SHA-256("")`, leaf `= SHA-256(0x00 || cid_bytes)` over the 36-byte record `cid_bytes`, node `= SHA-256(0x01 || left || right)`, RFC 6962 §2.1 split. Support both `tree_algorithm` values: `RFC9162_SHA256` (CT-tool compatible, RECOMMENDED) and `LCAP_MERKLE_V2` (leaf prefix `0x00 || domain_separator_hash || cid_bytes` binding the tree to one network). Implement the signed `room_checkpoint` record (root, tree size, policy/revocation epochs, previous checkpoint, signer authority) + its authority proof.

**Acceptance criteria:**
- Leaf/node hashing matches committed vectors for both algorithms; a verifier rejects a proof computed under a different algorithm than the checkpoint names.
- The checkpoint requires a valid authority proof; `tree_size`/`merkle_root`/epochs are bound into the signed body.
- `RFC9162_SHA256` output is byte-compatible with a standard CT verifier.

**Testing:** Unit — tree-hash vectors (both algorithms); checkpoint build/verify; cross-algorithm-proof rejection.

**Dependencies:** WS-R.0.6, WS-R.9.1.

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

**Testing:** Unit — mode budget/prefetch policy; pressure-degradation path. E2E — persistent-storage request + pressure UI (WS-R.18.3).

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

### WS-R.12.1 Ingestion pipeline + quarantine-before-commit
**ID:** WS-R.12.1 | **Ref:** OFFLINE_SPEC §24.1, §24.2

**Description:** Implement `apps/api/src/lcap/ingest.ts` running the §24.1 pipeline: receive pack/request → parse under resource caps → verify CIDs → strict schema → store raw verified records/proofs/blocks in CAS → resolve dependencies → verify proofs + authority chain → check revocations/policy epochs → check capability scopes/quotas → check device sequence/forks → quarantine or accept → append accepted records to the room log → update checkpoint schedule → return statuses/receipts/wants. The server MAY store pending dependencies but MUST NOT emit a record into canonical Licio application state until validation + policy pass (§24.2).

**Acceptance criteria:**
- A record is never promoted to canonical state before full validation; partials sit in quarantine.
- The pipeline runs under §27.1 caps and shares the `validate` core with the client (WS-R.8.2).
- Dependency resolution is topological (WS-R.9.1); outputs include statuses + receipts + wants.

**Testing:** Gated integration — full pipeline accept/quarantine; cap enforcement; canonical-emission-only-after-validation.

**Dependencies:** WS-R.8.2, WS-R.4.2, WS-R.12.2.

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

**Dependencies:** WS-R.12.1, WS-R.2.4.

---

### WS-R.12.4 HTTP API routes + status mapping
**ID:** WS-R.12.4 | **Ref:** OFFLINE_SPEC §29, §22.1, §22.1.1

**Description:** Implement `apps/api/src/lcap/routes.ts` (Hono) for the §29 endpoints: `POST /api/lcap/v2/pulse`, `POST /api/lcap/v2/exchange`, `POST /api/lcap/v2/packs`, `GET …/records/:cid`, `GET …/proofs/:cid`, `GET …/blocks/:cid` and `…/range`, the room checkpoint/inclusion/consistency reads, and bundle import/export (which MUST use the same pack validation as every other path). Apply the §22.1.1 HTTP status mapping (200/202/400/401/403/409/413/422/429+Retry-After/503) distinct from per-object `ObjectStatusV2`. CSRF/cookie/security-header middleware applies as elsewhere.

**Acceptance criteria:**
- Every endpoint is idempotent where the spec requires; bundle import shares the WS-R.4.2 validator.
- Request-level HTTP status follows the §22.1.1 table; `429`/`503` set `Retry-After`; `400`/`422` are non-retriable.
- Endpoints honor budgets/caps and never trust transport.

**Testing:** Gated integration — endpoint contract + status-code matrix; bundle-import-uses-same-validator; rate-limit `429`.

**Dependencies:** WS-R.12.1, WS-R.6.2, WS-R.9.3.

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

**Dependencies:** WS-R.8.2, WS-R.2.4, WS-R.9.4.

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

**Testing:** Unit — disclosure completeness; stealth-mode toggles. E2E — export-warning flow (WS-R.18.3).

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

**Dependencies:** WS-R.15.3.

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

**Description:** Implement the QR micro-bundle for tiny control material (checkpoint/revocation frontier, room invite/contact card, tiny signed emergency notice, small manifest pointer, relay contact card). QR MUST show a human-readable summary before display or import. Multi-QR large content is deferred unless carefully designed/tested. QR encode/decode uses a minimal, audited, install-script-free helper inside the lazily-loaded LCAP chunk (dependency-budget reviewed).

**Acceptance criteria:**
- QR carries only C0/tiny control objects; a human-readable summary precedes any import.
- Imported QR material runs the full validation pipeline (no transport trust).
- Multi-QR is gated off by default (documented deferral).

**Testing:** Unit — QR encode/decode round-trip for frontier/revocation cards; summary-before-import. E2E — scan-to-import flow.

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

### WS-R.15.4 Android courier profile (deferred PoC; manual file bridge first)
**ID:** WS-R.15.4 | **Ref:** OFFLINE_SPEC §22.5, §33.3, §37

**Description:** Specify and prototype (not ship) the optional Android courier that moves the **same packs** as every other transport over Nearby Connections / Wi-Fi Direct / Bluetooth / local hotspot / USB, with explicit controls (discovery/advertising on-off, who can exchange, which rooms/priorities, storage/battery budget, private-content exclusion). The courier MUST NOT create a separate data model or trust path. Phase 5 begins with a manual file bridge before any radio transport.

**Acceptance criteria:**
- The courier reuses the LCAP pack + validation pipeline; no parallel data model.
- All discovery/advertising/scope/budget controls are explicit and default-conservative.
- v0.2 requires none of this; it is a documented Phase-5 deferral with a manual-file-bridge first step.

**Testing:** Design doc + manual-file-bridge PoC test; controls matrix (when implemented).

**Dependencies:** WS-R.15.1.

---

### WS-R.15.5 WebTransport / WebRTC / IPFS bridges (deferred)
**ID:** WS-R.15.5 | **Ref:** OFFLINE_SPEC §22.6, §22.7, §37.2

**Description:** Record the deferral of WebTransport/WebRTC browser-to-browser/server transports and any public IPFS/libp2p bridge. These MAY improve transfer in some environments but MUST NOT be core v0.2 requirements; a public IPFS bridge may later publish only selected **public** blocks after privacy/moderation/abuse review. Correctness MUST never depend on a particular transport.

**Acceptance criteria:**
- The deferral is documented with the review gates required before any future enablement.
- No core LCAP behavior depends on these transports.

**Testing:** Documentation gate only (no v0.2 implementation).

**Dependencies:** none (deferral record).

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
- The corpus is the normative pin for determinism (referenced by WS-R.0.2/0.3/0.6 and WS-R.9.2/9.3).

**Testing:** Unit — vector replay across the codec/CID/COSE/Merkle modules.

**Dependencies:** WS-R.0.6, WS-R.9.3.

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

### WS-R.18.3 Network simulator + delivery metrics
**ID:** WS-R.18.3 | **Ref:** OFFLINE_SPEC §32.3

**Description:** Build a deterministic network simulator with random partitions, short contacts, asymmetric links, loss, duplicate/replay delivery, malicious relays, storage pressure, wrong clocks, stale revocation state, device-key compromise, and server checkpoint equivocation. Capture metrics: P0 propagation time, P1 text convergence, bytes per accepted record, outbox age, quarantine ratio, checkpoint freshness, fork-detection latency, media-starvation prevention, battery/storage budget compliance.

**Acceptance criteria:**
- The simulator reproduces each scenario deterministically from a seed.
- Metrics are emitted and thresholds asserted (e.g. P0 propagates ahead of media; fork detection bounded).
- Equivocation/compromise scenarios surface fork evidence / revocation as designed.

**Testing:** Simulation suite (node) — scenario + metric assertions; seeded determinism.

**Dependencies:** WS-R.8.3, WS-R.9.4, WS-R.5.4.

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

**Description:** Wire the §36 acceptance gates as CI checks and a launch checklist (record_cid/proof separation; deterministic vectors stable; browser↔Node interop; malformed-pack fuzz; C0-starvation; outbox durability; revocation propagation; checkpoint consistency; reviewed UI trust labels; no raw attention/IP/location in LCAP schemas; low-end-Android storage-pressure behavior; import/export privacy warnings; external threat-model review; private-room replication disabled or separately audited). In the same change set, add `docs/offline/README.md` (implementation reference), register WS-R in `docs/planning/00-index.md`, update the `CLAUDE.md`/`AGENTS.md` roadmap row (kept byte-identical), and bump the root `package.json` PATCH version. No `claude.ai/code/session_*` URL in any doc or PR body.

**Acceptance criteria:**
- Every §36 gate has a corresponding CI check or signed-off manual gate; the checklist is in the README.
- The master index lists WS-R accurately; `CLAUDE.md ≡ AGENTS.md` (empty `diff`); version bumped.
- High-risk use is documented as gated on external security review (no false "secure" claim).

**Testing:** `pnpm check:policy`; the CLAUDE.md ≡ AGENTS.md byte-identical assertion; the acceptance-gate CI suite.

**Dependencies:** all WS-R implementation cards (lands with them).

---

## Dependency graph (within WS-R)

```
R.0.1 ─ R.0.2 ─┬─ R.0.3 ─┬─ R.0.4 ─┐
               │         │         ├─ R.0.6 ─ R.0.8
               │         └─────────┘   │
               └─ R.0.7 ───────────────┘
R.0.5 ──────────────────────────────── R.0.6
R.0.6/0.7 ─ R.1.1 ─ R.1.2 ─ R.1.3 ─ R.1.4 ─ R.1.5      (identity/capability/revocation)
R.1.2 ─ R.2.1 ─ R.2.2 ; R.2.1 ─ R.2.3 ; R.2.1/R.1.3 ─ R.2.4
R.0.3 ─ R.3.1 ─ R.3.2 ; R.3.1 ─ R.3.3 ; R.0.3 ─ R.3.4
R.5.1 ─ R.5.2 ─┬─ R.4.1 ─ R.4.2 ─ R.4.3 ; R.4.1 ─ R.4.4   (writer needs scheduler order)
               └─ R.5.3 (needs R.10.2) ; R.5.2 ─ R.5.4
R.6.1 ─ R.6.2 ─ R.6.3 ; R.6.2 ─ R.6.4 ; R.6.2/R.2.4 ─ R.6.5
R.6.1/R.1.4 ─ R.7.1 ─ R.7.3 ; R.1.5/R.5.2 ─ R.7.2
R.1.4/R.1.5 ─ R.8.1 ─ R.8.2 ─ R.8.3
R.12.2 ─ R.12.1 ─ R.9.1 ─ R.9.2 ─ R.9.3 ─ R.9.4 ; R.12.1 ─ R.12.3 ; R.12.1/R.6.2/R.9.3 ─ R.12.4
R.10.2 ─ R.10.1 ; R.11.3 ─ R.10.3
R.11.3 ─ R.11.1 ─ R.11.2 ─ R.11.4 ; R.2.1/R.1.2 ─ R.11.5
R.8.2/R.2.4/R.9.4 ─ R.13.1 ─ R.13.2
R.4.2 ─ R.14.1 ; R.6.3/R.4.4 ─ R.14.2 ; R.0.7 ─ R.14.3 ; R.15.3 ─ R.14.4
R.4.* ─ R.15.1 ─ R.15.4 ; R.6.1 ─ R.15.2 ; R.12.4 ─ R.15.3 ; (defer) R.15.5
R.2.1/R.11.5 ─ R.16.1  (bridge to WS-S)
R.8.1/R.10.1 ─ R.17.1 ─ R.17.3 ; R.11.2/R.6.2 ─ R.17.2
R.0.6/R.9.3 ─ R.18.1 ; R.5.4/R.8.3/R.10.3 ─ R.18.2 ; R.8.3/R.9.4 ─ R.18.3
R.14.1/R.0.8/R.4.2 ─ R.18.4 ; R.18.1/R.15.1 ─ R.18.5 ; (all) ─ R.18.6
```

Cross-stream order: **R.0** (codec → CID → AAD → ES256 → COSE → schemas → suites) is the gate for everything. Then **R.1** (identity/capabilities/revocations) and **R.2/R.3** (records/blocks) in parallel; **R.5** (scheduler) ↔ **R.4** (pack) co-develop because the writer emits the scheduler's transfer order; **R.6/R.7/R.8** (sync/reconciliation/trust) build on records + scheduler; **R.9** (checkpoints) sits on the server **R.12** + DB; **R.10/R.11** (liveness/storage) underpin the client; **R.13/R.14** (conflict/privacy-DoS) harden; **R.15/R.16** (transports/private bridge) and **R.17** (UI) ride the validated core; **R.18** (tests/sim/acceptance) runs continuously and gates the close. The phase mapping to OFFLINE_SPEC §35 is: Phase 0 = R.0; Phase 1 = R.1/R.6/R.11/R.12; Phase 2 = R.3/R.4/R.5/R.15.1–2; Phase 3 = R.9/R.10; Phase 4 = R.15.3; Phase 5 = R.15.4; Phase 6 = R.7.3/R.16/witness hardening/PQ reservation.

## Milestone gate additions

| Gate | Cards | Requirement |
|---|---|---|
| Record/proof separation | R.0.3, R.0.6, R.18.2 | `record_cid` is independent of signature bytes; multi-proof never changes identity. |
| Deterministic encoding | R.0.2, R.18.1 | LDC vectors stable; same logical value ⇒ identical bytes; closed-schema unknown-field rejection. |
| Crypto interop | R.0.5, R.18.5 | Browser↔Node ES256 low-S sign/verify and bundle round-trip pass. |
| No transport trust | R.8.3 | Every ingress funnels through `validate`; hostile relay ≡ trusted friend in trust state. |
| C0 cannot starve | R.5.4 | `check:lcap-scheduler` proves control/dependency closure never preempted by media/bulk. |
| Outbox durability | R.10.3 | Hard pins survive eviction; signed-unsent records retry on every opportunity. |
| Revocation propagation | R.1.4, R.7.1 | Revocations are P0/C0, reconciled before content; stale frontiers labelled. |
| Checkpoint consistency | R.9.2, R.9.3, R.9.4 | Inclusion/consistency verify (RFC 9162-compatible); equivocation → gossiped fork evidence. |
| LCAP doctrine | R.14.3 | No raw attention/IP/location/applause field in any LCAP schema; gates in CI. |
| Honest UI | R.17.1 | No single "verified"/"delivered" badge; provisional/stale/conflict/revoked/rejected explicit. |
| Malformed-pack safety | R.4.2, R.14.1, R.18.4 | Bombs/forks/downgrade/replay rejected; nothing renders before trust projection. |
| Docs byte-identical | R.18.6 | CLAUDE.md ≡ AGENTS.md; README + index updated; version bumped; no session URL. |

## Definition of done (workstream)

- LCAP records are identified by the deterministic body hash only; signatures are detached COSE_Sign1 proofs; `record_cid` is independent of proof bytes, pinned by conformance vectors that pass in browser and Node.
- The full trust pipeline — device certificate → capability → device proof → revocation knowledge → checkpoint inclusion/consistency → witnesses — is implemented; every ingress (HTTPS, bundle, QR, relay, courier) funnels through the single shared `validate(record_cid)`, and the path of arrival never confers trust.
- The lane scheduler guarantees C0/dependency closure can never be starved by media/bulk, proven by the named `check:lcap-scheduler` gate and the §32.2 property suite; the durable outbox hard-pins local material against eviction.
- Server ingestion quarantines before commit, accepts idempotently by `record_cid`, appends topologically to the room log, issues signed receipts, and exposes the §29 endpoints with the §22.1.1 HTTP status mapping; the `lcap_v2` IndexedDB and the new `lcap_*` Postgres tables coexist with the shipped stores without migration of either.
- Manual `.licio-bundle` export/import is a first-class transport with full privacy disclosure; QR micro-bundles carry C0 control material; the untrusted relay can store/serve/receipt but never accept; courier and WebTransport/IPFS bridges are documented deferrals that reuse the same packs and trust path.
- Private-room content is carried as ciphertext + opaque hints only; LCAP owns no group-key authority (that is WS-S / PRIVATE_SPEC §10), and no plaintext/key/op-head/real-private-room-id ever enters an LCAP record, log, or receipt.
- The UI exposes trust and liveness as distinct, honest, accessible states (WCAG 2.2 AA), never collapsing them into one badge and never using *secure/trusted/delivered/final/safe* without exact meaning; the six operational modes (incl. Emergency text and Stealth) apply their budget/discovery policies.
- The deterministic-vector, property, network-simulation, security/fuzz, and browser↔Node interop suites pass; the §36 acceptance gates are wired in CI; high-risk/private-room use is documented as gated on external security review.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm lint:security`, `pnpm check:deps`, `pnpm check:workspace-deps`, `pnpm check:no-applause`, `pnpm check:no-raw-egress`, `pnpm check:lcap-schema-egress`, `pnpm check:lcap-scheduler`, `pnpm check:sw`, and `pnpm check:policy` all pass; the web LCAP module is code-split (initial-bundle gate unaffected); docs are updated in the same change set and the PATCH version is bumped.
