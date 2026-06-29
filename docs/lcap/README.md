# LCAP v0.2 — implementation reference (WS-R, Part I of the Decentralized Data Plane)

This is the implementation reference for **WS-R (Offline Content Availability —
LCAP v0.2)**, Part I of the Decentralized Data Plane. The normative source
specification is [`docs/OFFLINE_SPEC.md`](../OFFLINE_SPEC.md); the staged plan and
the 104 atomic WS-R cards live in
[`docs/planning/19-decentralized-data-plane.md`](../planning/19-decentralized-data-plane.md).

## Scope of this cut

LCAP is a delay-tolerant, content-addressed, signed synchronization protocol that
lets Licio content stay creatable, verifiable, transferable, and reconcilable
under intermittent connectivity, hostile networks, and incomplete trust. The full
workstream is large (104 cards across WS-R.0 → WS-R.18). **This cut ships the
entire pure-protocol core of WS-R** as the zero-dependency `@licio/lcap` package
— the record, trust, and sync-decision planes implemented as deterministic,
I/O-free, exhaustively-tested logic:

- **WS-R.0** foundations (deterministic CBOR / CIDs / COSE-ES256 proofs / schemas);
- **WS-R.1** identity (device certs, capabilities, the signing chain, revocation,
  the §18.3 steps-6-11 identity-chain validator);
- **WS-R.2** the record graph (contribution mapping, edit/tombstone projection,
  display ordering, device-fork detection);
- **WS-R.3** blocks, fixed-size chunking + reassembly, attachment laziness, and
  Compression-Streams gzip/deflate with bomb caps;
- **WS-R.4** the packfile / `.licio-bundle` format (streaming writer/reader,
  partial import + quarantine, bundle manifest);
- **WS-R.5** the anti-starvation lane scheduler (byte reservations, DRR, the
  clamped finite score) + the `check:lcap-scheduler` CI gate;
- **WS-R.6** the sync-protocol decision plane (the pulse + frontier diff, exchange
  request/response assembly, resource/privacy budget shrinking, privacy-scoped
  interests, wants + resumable range fetch, and idempotent-ingestion keying);
- **WS-R.7** reconciliation (the §17.1 frontier-first order and `minimalClosure` —
  the §17.5 closure the lane scheduler now consumes);
- **WS-R.8** trust projection — the single `validate(record)` entry point over the
  §18.2 state lattice;
- **WS-R.9** the RFC 9162 Merkle / checkpoint plane (inclusion + consistency
  proofs, witnesses, fork evidence);
- **WS-R.10** the liveness model + receipts + durable-outbox logic;
- **WS-R.13** conflict-table dispatch + the trust/safety-aware visible-thread
  projection.
- **WS-R.12.1 (decision core)** the server-ingestion commit-stage orchestrator
  (`ingestRecord`) — idempotency + the shared `validate()` projected through the
  §25.1 conflict table + the §24.2 room-log-append gate + receipt issuance +
  missing-dependency wants; the Postgres CAS/room-log store and the Hono routes
  (WS-R.12.2/12.4) are the deferred I/O binding.

The WS-R.12.1a/b/c server binding is shipped in
`apps/api/src/lcap/server-ingest.ts` (`LcapIngestServer`).  Its durable state — a
CID-verified content-addressed store, the per-room acceptance log, the acceptance
index (idempotency by `record_cid`), and append-only device-fork evidence — lives
behind the **`LcapServerStore` async boundary** (`store.ts`, WS-R.12.2), with BOTH
an in-memory adapter and a **gated Drizzle/Postgres adapter** (`drizzle-store.ts`,
migration `0039`, selected by `service.ts` when `DATABASE_URL` is set), proven
interchangeable by the parameterized store-contract test.  The engine binds the pure
`ingestRecord` decision + **server-computed validation** (`validateContribution` runs the
same `validate()` the client uses over registered identity state — device
certificates, room capabilities, account/room authority keys, and revocations —
so a verdict is never trusted from the client), and `commitBatch` — ordered batch
ingestion driven by the §24.4 `resolveIngestionOrder` resolver: parents/certs/
capabilities before children, absent dependencies quarantined with precise wants,
dependency cycles rejected), and graph-guarded before any expansion by the §27.2
`checkDependencyGraph`
(WS-R.14.2 — cycle/fan-out/depth/duplicate-dependency/private-in-public/unknown-
critical-field detectors, each mapped to a §16.11 wire rejection code, with the
whole-batch node-count cap checked first so the guard cannot itself be a DoS
vector).  The **WS-R.11 client offline store is complete** in `apps/web/src/lcap`:
the `lcap_v2` IndexedDB schema (`db.ts` — the 12 §23.1 stores + indexes + versioned
migration, a SEPARATE database from the WS-C `licio` store, with a static isolation
check, R.11.3a); the §23.2 durability layer (`store.ts` — cursor-only streaming,
blob↔metadata separation, ATOMIC verified-record commit, capped transactions, and
transient-quota retry, R.11.3b); the §21.2 pinning/eviction policy (`gc.ts` — hard-pin
invariance, R.11.1); the §21.3 storage modes + pressure degradation (`storage-modes.ts`,
R.11.2); the §23.3 C0-first sync orchestration (`sync-triggers.ts`, R.11.4); and the
§21.4 privacy-aware replication gate (`replication.ts` — private content is default-deny
unless encrypted + permitted + user-selected, R.11.5).  The **WS-R.12.4 §29 HTTP API
is shipped** (`apps/api/src/lcap/routes.ts`), all with the §22.1.1 status mapping and
mounted through the global security middleware:

- the content-READ endpoints `GET /api/lcap/v2/{records,proofs,blocks}/:cid` (RFC 7233
  resumable range/206 + 416 reads);
- the rate-limited pack-import `POST /api/lcap/v2/packs` (CSRF-exempt; read under the
  WS-R.4.2 caps → every CID-verified frame durably stored, so its proofs/blocks are then
  fetchable via the GET routes → identity frames registered → contributions committed
  through validate→guard→commit → one §16.11 status per object) + the §29.8
  `POST /api/lcap/v2/bundles/import` web alias (the SAME validator; CSRF-protected);
- the §29.1 `POST /api/lcap/v2/pulse` C0 frontier exchange + the §29.2
  `POST /api/lcap/v2/exchange` main bidirectional path — both return the server's
  §17.2/§17.3 frontiers (per-room checkpoint tree sizes keyed by the shared
  `roomIdHash`, the global revocation epoch) AND serve the peer's explicit wants as a
  budget-bounded content pack (the pulse's C0 `critical_pack`, the exchange's
  `response_pack`; `repack.ts` repacks held objects from their bytes with
  content-derived §15.1.1 lane/priority hints + a conservative privacy label —
  serving by CID like the GET routes, so no new exposure — and marks the exchange
  `partial` when a held want is dropped for the response budget); the exchange also
  ingests its optional push pack through the shared validator (→ `accepted_push`) and
  derives `wanted_from_client` from the server's own frontier diff (`applyPulse`);
- the §29.7 room reads `GET /api/lcap/v2/rooms/:roomId/{checkpoint,proofs/inclusion,
  proofs/consistency}` — the (unsigned) tree head + RFC 9162 inclusion/consistency
  proofs computed over the §19.1 room log reconstructed from the canonical acceptance
  order; the served proofs verify against an independently-built log;
- the §29.8 `POST /api/lcap/v2/bundles/export` — a room's content closure repacked from
  held bytes via an import-captured closure index (`indexRecordEdge`/`recordEdges` over
  migration `0040`).  SELF-CONTAINED + re-validatable: each accepted record is led by the
  IDENTITY it needs to validate (its cited capability + the signer's device certificate,
  each with their authority proofs — a record→`identity` edge), then its own proofs, then
  its referenced blocks, so a re-import into a server holding only the root-of-trust
  authority keys VALIDATES the contribution (not merely stores it).  UNSIGNED (each record
  self-authenticates via its included proof), generic filename.  GATED: the POST carries a
  device-signed, freshness-windowed `export_request` and proceeds only when the requester
  holds a non-revoked, authority-signed `may_export_bundle` capability for the room
  (`verifyExportAuthorization`; CSRF-exempt + rate-limited — review #5).

The transport plane is now **driven live, not just defined.**  `syncRoomOverP2p`
(`apps/web/src/lcap/transports/sync-over-p2p.ts`, WS-R.15.6) is the FIRST real
runtime consumer of the WebRTC carrier: it derives a PUBLIC signaling key by HKDF
over the public `roomIdHash` (`signal-key.ts` `derivePublicSignalKeyBytes` — the
PUBLIC plane only; signaling secrecy is never LCAP's trust root, content-addressing
+ COSE_Sign1 are), establishes a live `WebrtcTransport` over the server-blind
rendezvous (`connectLcapWebrtc`, dynamic-import only so `check:lcap-p2p-split`
holds), and runs ONE §16 exchange through `offlineExchange` — whose
`selectTransports` still forces the HTTPS anchor LAST (the anchor-last + public-only
carriage policy is structurally preserved even though the WebRTC peer is preferred);
it falls back to the anchor alone when the channel never opens, so correctness never
depends on the optional carrier.  Because an SCTP datachannel message has a
small cross-browser-safe size limit, `@licio/lcap-p2p`'s `webrtc/fragment.ts`
(`fragmentMessage` / `FragmentReassembler`) splits an exchange pack into ≤ 16 KiB
self-describing fragments and reassembles the EXACT bytes fail-closed (a bad
version / out-of-order seq / conflicting in-flight header / over-cap declared
length aborts the reassembly; the 16 MiB §27 DoS bound caps the memory one inbound
exchange may pin before the validator sees it).

**WS-R.16.1 — the cross-plane bundle bridge — is shipped**
(`apps/web/src/lcap/cross-plane-bridge.ts`): a WS-S private-p2p
`PrivateEncryptedEnvelope` rides inside an LCAP `.licio-bundle` as an opaque
`encrypted_payload` block whose CID is computed over the CIPHERTEXT bytes (§28.1 —
a plaintext CID for private content can never exist).  `exportPrivateEnvelopesToBundle`
labels the carrier suite `MLS-derived-AEAD`, so the §28.2 schema STRUCTURALLY forbids
a plaintext digest/size hint (§10.6); the only hints carried are already-public
fields (the epoch counter, the AEAD nonce, the `aad_hash` commitment).
`importBundleToPrivateEnvelopes` re-hashes every block (CID + structure only — it
NEVER decrypts) and re-parses each recovered ciphertext through the private-p2p
envelope schema, then HANDS the opaque envelopes to the caller so the private-p2p
engine performs the real trust projection (§8.3 — the container confers no trust;
a stale/forged envelope round-trips opaquely and is quarantined later).

**Gate-19 (WS-R.15.7b / WS-S.4.4) is now closed against REAL takedown state.**
`@licio/lcap-p2p`'s `IpfsBridge` carries the structural public-only + takedown-recheck
gate but cannot import `@licio/db`; the production DB binding lives on the apps/api
side: `lcap_block_provenance` (migration `0046`) maps `block_cid → (target_type,
target_id)`, `apps/api/src/lcap/takedown-oracle.ts` (`DrizzleTakedownOracle`)
resolves a block CID to its content targets and reads the live takedown status
through the single `takedownInForce` rule (fail-closed — a thrown query is treated
as a halt, never as "no takedown"), and `publisher.ts` (`LcapPublicPublisher`)
re-checks the live oracle at PUBLISH **and** republish behind
`assertPublicGatewayEligible` + `decideBlockPublish`.  The publish path DERIVES the
content's visibility/storage-mode SERVER-SIDE (`publish-eligibility.ts`:
`drizzlePublishEligibility` resolves each content target to its story's room
`storage_mode` + `visibility`; a source is a public catalog entry) rather than trusting
caller-supplied signals — a block is publishable ONLY if EVERY target resolves to a
`public` item in a `server`-storage room, and an absent resolver is fail-closed.  The
env-gated `POST /api/lcap/v2/public-bridge/{publish,republish}` route (503
`public_bridge_not_configured` unless `LCAP_IPFS_GATEWAY_URL` /
`LCAP_IPFS_PINNING_URL` / `DATABASE_URL` are all set) is the real caller — so
`@licio/lcap-p2p` is now an `apps/api` workspace dependency (the server-side binding
it structurally cannot carry itself; budget-exempt, no initial-bundle constraint, so
`check:lcap-p2p-split` does not apply).

The remaining WS-R cards are **I/O integration** — the transport profiles' remaining
adapters (WS-R.15), the client surface polish (WS-R.17), and the network simulator
(WS-R.18) — plus the live two-browser convergence E2E for the WS-S private plane.
The optional, non-authoritative set-reconciliation filters (WS-R.7.3) are deferred by
the spec itself.  Discovery currently uses a single 15-minute rendezvous time bucket, so
peers whose clocks straddle a boundary may not discover each other until both roll into
the same bucket (a known non-blocking residual; §5.4 metadata table).

## What is implemented (WS-R.0 — `packages/lcap`)

A new **zero-runtime-dependency** workspace package, `@licio/lcap`, implementing
the deterministic-encoding, content-addressing, and detached-proof primitives.
The cryptographic + encoding core (`cbor/`, `cid/`, `cose/`) carries **no npm
imports** — SHA-256/ECDSA come from WebCrypto and the CBOR/COSE subset is
hand-rolled (OFFLINE_SPEC §31.1); only the `schemas/` layer uses `zod`, the
monorepo's normative schema baseline (the spec names the
`packages/lcap/src/schemas/` zod schemas as normative, OFFLINE_SPEC line 102).

| Card | Module | What it does |
|---|---|---|
| WS-R.0.1 | package scaffold | `@licio/lcap` workspace; registered in `check:workspace-deps` (allow-list `['@licio/shared']`), the root build chain, `tsconfig`, and the Vitest projects + coverage |
| WS-R.0.2a | `cbor/encode.ts` | the LDC deterministic encoder — shortest-form integers, definite lengths, **encoded-key-sorted** maps, UTF-8/NFC text, no floats/tags/undefined (RFC 8949 §4.2.1 + §9.1.2) |
| WS-R.0.2b | `cbor/decode.ts` | a bounded recursive-descent **strict** decoder that rejects (never normalizes) any non-canonical input with `LdcDecodeError(reason, offset)`; enforces the §27.1 depth/size/item caps |
| WS-R.0.2c | `test-vectors/cbor.json` | the normative conformance corpus + the P1 (determinism) / P2 (round-trip) / P3 (fail-closed) property suite; identifier-position NFC enforcement |
| WS-R.0.3 | `cid/` | `cidFor` / `parseCid` / `verifyCid` over the §9.2 layout `0x01 ‖ kind_code ‖ 0x12 0x20 ‖ sha256(body)` + RFC 4648 §6 base32; the `kind_code` is bound into the hash preimage so a record digest can never be reparsed as a block CID |
| WS-R.0.4 | `cose/aad.ts` | the §9.5 domain-separator grammar + the §10.2.2 `external_aad` builder (the separator is only ever the first array element, never hand-concatenated) |
| WS-R.0.5a | `cose/ecdsa.ts` | ES256 sign/verify with **mandatory low-S canonicalization** — the malleability twin `(r, n−s)` is rejected by `verifyEs256` even though it is cryptographically valid |
| WS-R.0.5b | `cose/keys.ts`, `runtime.ts` | non-extractable device-key generation, COSE_Key round-trip, and a runtime adapter resolving WebCrypto from `globalThis` (no `node:` import leak into a browser bundle) |
| WS-R.0.6a | `cose/sign1.ts` | the COSE_Sign1 detached signer: `Sig_structure = ["Signature1", protected, external_aad, record_body]`; `record_cid` is independent of the proof bytes (§5.1), so one body carries multiple proofs |
| WS-R.0.6b | `cose/sign1.ts` | the §10.2.4 six-step detached verifier with exact `ObjectStatusV2` status mapping (`rejected_bad_cid` / `_bad_signature` / `_high_s_signature`); no downgrade |
| WS-R.0.7 | `schemas/` | strict (`.strict()`) closed-schema records/proofs (device cert, capability, revocation, contribution event, block/chunk descriptors) **paired with LDC decode/encode** so the wire bytes and the validated object cannot diverge; `record_version`/kind routing |
| WS-R.0.8 | `cose/suites.ts` | fail-closed suite resolution + downgrade-resistant negotiation (ES256 enabled; Ed25519 reserved/disabled); a reserved hybrid-proof algorithm id for §10.4 |

### Doctrine invariants enforced here

- **`record_cid` excludes proof bytes (ABSOLUTE, §5.1).** CID identity is the hash
  of the deterministic body only; signatures are detached. Pinned by the
  conformance vectors and the multi-proof builder test.
- **Determinism is pinned by vectors (§9.1.5).** `src/test-vectors/{cbor,cid,sign1}.json`
  are golden files; any change that alters a published vector is breaking and
  bumps the LDC profile version. The property suite proves equal logical values
  encode identically and round-trip exactly.
- **Fail-closed everywhere (§9.1.4, §10.3, §27).** Unknown critical fields,
  unknown/disabled algorithms, undecodable framing, and over-budget input all
  fail closed with a typed reason.
- **No transport trust (§18.4).** The verifier path is identical regardless of how
  a record arrived (there is no transport layer in this cut yet, but the single
  `verifyDetached` entry point is the one that future transports will reuse).

## Source layout

```
packages/lcap/
├── package.json                 -- @licio/lcap (deps: @licio/shared, zod)
├── tsconfig.json                -- strict, composite; references ../shared
├── vitest.config.ts             -- node project, reuses vitest.shared
└── src/
    ├── index.ts                 -- public surface (all sub-areas re-exported)
    ├── runtime.ts               -- WebCrypto adapter + BufferSource helper (no node: leak)
    ├── priority.ts              -- the §15.1.1 priority ↔ class ↔ lane SSOT
    ├── cbor/                     -- LDC deterministic CBOR (encode, decode, errors, types)
    ├── cid/                      -- CID construction + RFC 4648 base32 + sha256
    ├── cose/                     -- aad, ecdsa (low-S), keys, suites, sign1 (build + verify)
    ├── schemas/                  -- strict zod records/proofs/pack/checkpoint/receipt + the LDC codec
    ├── identity/                 -- cert, capability, sequence chain, revocation, chain validator
    ├── records/                  -- contribution mapping, edit/tombstone projection, fork detection
    ├── block/                    -- descriptor, fixed-size chunking, attachment split, compression
    ├── pack/                     -- uvarint, streaming writer/reader, partial import, manifest
    ├── scheduler/               -- reservations, candidate closure, DRR allocator, clamped score
    ├── sync/                     -- §16/§17 sync-decision plane: closure, frontiers, pulse,
    │                                reconcile, budgets, interests, wants/resume, exchange, server-ingest
    ├── checkpoint/              -- RFC 9162 merkle, room log, checkpoint, inclusion/consistency, witness
    ├── validate/                -- the §18 trust-state lattice + the single validate() entry point
    ├── liveness/                -- liveness state machine, receipts, durable-outbox logic
    ├── conflict/                -- §25.1 conflict dispatch + visible-thread projection
    ├── test-vectors/             -- normative golden corpus (cbor/cid/sign1 .json)
    └── __tests__/                -- unit + conformance-replay + determinism property suites
```

## Testing

`pnpm --filter @licio/lcap test` runs the suite standalone (≈31 files, ~253 tests
at the time of writing). Highlights: per-major-type CBOR byte assertions + the
§9.1.5 integer table + the full decode rejection matrix; CID known-answer
grounding (SHA-256 of "" and "abc"); the ES256 low-S boundary matrix and the
malleability twin; the COSE_Sign1 six-step verifier matrix; the identity-chain
accept/quarantine/reject/revoke matrix; the arrival-order-independent thread
projection; chunk reassembly with corrupt-chunk localization and a
compression-bomb abort; the packfile round-trip + cap + tamper matrix; the
**exhaustive RFC 9162 Merkle** inclusion (all leaves, sizes 1-9) and consistency
(all first/second pairs) proofs with fork/rewrite detection; the full
`validate()` trust-projection staged matrix incl. the no-transport-trust
property; the scheduler's anti-starvation invariants (also enforced by the
named `pnpm check:lcap-scheduler` CI gate over adversarial fixtures); and the
sync-decision plane — `minimalClosure` sufficiency/cycle-safety + scheduler
integration, the frontier behind/ahead matrix, pulse build/apply, the §17.1
reconciliation ordering, monotonic budget shrinking, the interest privacy/leak
matrix, want priority + resume ranges, the idempotency pre-gate, exchange
assembly + status handling, and the server-ingestion commit-stage decision
(`ingestRecord`: idempotency, the §25.1 conflict-table projection, the §24.2
room-log-append gate, receipts, and missing-dependency wants). Package coverage is
comfortably above the 80% global gate.

Browser↔Node crypto-interop vector replay (the gated WS-R.0.5b leg) is wired
through the same committed vectors; a Playwright/WebCrypto cross-runtime harness
is a later card (the package is already runtime-agnostic via `runtime.ts`).

## Status

| Area | Cards | Status |
|---|---|---|
| WS-R.0 — foundations (encoding, CID, COSE/ECDSA, schemas) | 0.1 – 0.8 | **Shipped** |
| WS-R.1 — identity, certificates, capabilities, revocations, chain validator | 1.1 – 1.5 | **Shipped** |
| WS-R.2 — event records, projection, ordering, fork detection | 2.1 – 2.4 | **Shipped** |
| WS-R.3 — blocks, chunking, attachment laziness, compression | 3.1 – 3.4 | **Shipped** |
| WS-R.4 — packfile / `.licio-bundle` (writer, reader, import, manifest) | 4.1 – 4.4 | **Shipped** |
| WS-R.5 — lane scheduler + `check:lcap-scheduler` gate | 5.1 – 5.4 | **Shipped** |
| WS-R.6 — sync protocol (pulse, exchange, interests, wants, budgets, idempotency) | 6.1 – 6.5 | **Shipped** (decision plane; the `/pulse` + `/exchange` HTTP wire shipped in WS-R.12.4) |
| WS-R.7 — reconciliation (frontier-first order, `minimalClosure`) | 7.1 – 7.2 | **Shipped** (7.3 set-recon filters deferred by spec) |
| WS-R.8 — trust projection (`validate`) | 8.1 – 8.3 | **Shipped** |
| WS-R.9 — Merkle / checkpoint / inclusion / consistency / witness | 9.2 – 9.4 | **Shipped** (9.1 server-append logic core; DB binding in WS-R.12).  **Server-side checkpoint ISSUANCE shipped** (WS-R.9.2b): `LcapIngestServer.issueCheckpoint` builds + room-authority-signs (real COSE_Sign1 via `signCheckpoint`) + durably stores a `room_checkpoint` over the canonical log, idempotent by tree size, chained via `previous_checkpoint_cid`, surfaced in the §17.2 frontier + the §29.7 route, on the lease-guarded hourly tick.  Proven against the room-authority key (`verifyCheckpoint`) + an independent merkle-root recompute.  **Production note:** issuance needs a registered room-authority SIGNING key (`registerRoomAuthoritySigner`) — provisioned with the WS-L/WS-M room-governance key lifecycle; a node with no signer simply does not checkpoint (the §29.7 head still serves), so the engine is complete + tested but emits nothing until those keys exist |
| WS-R.10 — liveness, receipts, durable outbox | 10.1 – 10.3 | **Shipped** (IndexedDB binding in WS-R.11).  **Server-emitted signed receipts shipped** (WS-R.10.2): `LcapIngestServer.issueReceipts` groups ingestion outcomes by type, signs one `receipt` per group (real COSE_Sign1 via `signReceipt`), stamps each status with its `receipt_cid`, durably stores record + proof, and rides them on the §29.3 `/packs` + §29.2 `/exchange` responses — a receipt is an availability HINT, never content trust.  **Production note:** emission needs a configured node receipt key (`configureReceiptIssuer`); without it the statuses pass through unchanged (a missing receipt is always safe) |
| WS-R.13 — conflict dispatch + visible-thread projection | 13.1 – 13.2 | **Shipped** |
| WS-R.12 — server ingestion | 12.1, 12.2, 12.4 | **Decision core + §24.4 resolver + server-computed validation + in-memory & gated-Drizzle bindings + the full §29 route surface shipped** (`ingestRecord`, `resolveIngestionOrder`, `validate`; `apps/api/src/lcap` `LcapIngestServer` incl. `validateContribution`/`commitBatch`/frontiers/room-Merkle reads; `routes.ts` content reads + `POST …/packs` + `/pulse` (incl. C0 `critical_pack`) + `/exchange` (incl. `response_pack`) + `/rooms/:id/{checkpoint,proofs/*}` + `/bundles/import` + `POST /bundles/export` (room closure via the migration-`0040` closure index; capability-gated, review #5); the `LcapServerStore` boundary over migrations `0039`+`0040`) — **§29 route surface complete** (the WS-R.15.1a/b client bundle UI shipped under WS-R.15) |
| WS-R.14 — privacy + DoS controls | 14.1a, 14.1b, 14.2, 14.3, 14.4 | **Shipped**: the §27.1 resource-cap SSOT (`limits/caps.ts` — one frozen config every parser path sources, profile-tunable/never-disable-able, `checkCap`/`enforceCap`; the server parse enforces the CPU-time + quarantine-byte caps, 14.1a); the §27.2 graph guard run over the pack's DECLARED DAG before storage (14.1b); the §27.3 relay quotas + §27.4 no-PoW/no-address policy (`limits/relay-quota.ts`, 14.4); the §26.2 export-disclosure + §26.3 stealth policy (`privacy/`, 14.2 — interest-privacy in R.6.3); the §3.7/§36 doctrine CI gates (`check:lcap-schema-egress` + no-applause/no-raw-egress over the LCAP trees, 14.3). The 14.2 export UI flow is WS-R.15.1a |
| WS-R.11 — IndexedDB client offline store | 11.1 – 11.5 | **Shipped** (`apps/web/src/lcap`: `lcap_v2` schema + the §23.2 durability layer + pinning/eviction + storage modes + the §21.4 replication gate). **The §23.3 C0-first sync hooks are wired** (`sync-boot.ts` attaches the online/focus/visibility trigger orchestrator + fires an app-open pulse; `sync-pass.ts` runs ONE minimal frontier-only C0 pulse against `/api/lcap/v2/pulse` from a LAZY dynamic-import chunk so the codec stays off the initial bundle; the SW `sync` handler (`public/sw-push.js`, tag `lcap-c0-sync`) posts the secondary background-sync nudge; booted from `lib/bootstrap.ts`).  **The §23.3 suppression conditions are fully LIVE:** app open, regained connectivity, focus, and the background nudge are ALL gated automatic triggers (only a deliberate user action forces) — suppressed offline, under data-saver, on a non-charging low battery (the Chromium Battery Status API via `initBatteryTracking`; absent ⇒ honestly "unknown"/false), and in **Stealth** mode (the persisted `mode-state` operational mode → its `StorageMode`; Stealth also skips background-sync registration), so a Stealth device never auto-contacts the server, not even on open |
| WS-R.15 — transport profiles + the seam | 15.1a/b, 15.2, 15.3, 15.4b, 15.5, 15.6, 15.7 | **The transport plane is shipped over one seam.** The **§22.6 `LcapTransport` seam** (`packages/lcap/src/transport`): the byte-channel interface every carrier implements + the selection policy that forces a server-mediated transport LAST (the always-correct anchor) + the public-only carriage gate + the fallback driver (15.4b). The **WS-R.15.1a/b offline `.licio-bundle` export+import** run CLIENT-LOCAL (`apps/web/src/lcap/bundle-{export,import}.ts` + `OfflineBundlePanel` + `/profile/offline`), the real pack writer/reader in a lazy chunk. The **WS-R.15.3 relay decision core** (`apps/api/src/lcap/relay.ts` `LcapRelay`). The client carriers over the seam (`apps/web/src/lcap/transports`): the **HTTPS anchor**, the platform **WebTransport** adapter + feature-detect (15.5), the **courier** ferry over a `CourierMedium` (15.4b; the native Nearby/BLE channels ride the same adapter behind the deferred Capacitor shell 15.4a/c/d), and the **registry** running `fallbackExchange` with WebRTC loaded by DYNAMIC import. The new code-split **`@licio/lcap-p2p`** package: the **WebRTC** data-channel transport + the server-blind AES-GCM signaling envelope (its AAD length-prefix-binds room + peer pair, an unambiguous canonical encoding, so a captured blob opens in no other room/peer context) + the §26.4 ICE/NAT-privacy policy (15.6a/b) and the dependency-free **IPFS gateway bridge** — the verification-preserving `block_cid ⇄ CIDv1(raw,sha2-256)` map, CID-re-verified on BOTH the fetch path (an untrusted gateway returning wrong bytes is rejected) and the publish path (mislabeled bytes are never pinned), public-only publish (15.7a/b). The **§22.3 QR micro-bundle** (`apps/web/src/lcap/transports/qr`): a hand-rolled byte-mode encoder (jsQR-round-trip-proven) + lazy jsQR still-image decode (15.2). Server: the server-blind `POST /api/lcap/v2/p2p/signal` rendezvous + the CSRF-protected `POST …/p2p/signal/poll` drain (15.6a). Gates: `check:lcap-p2p-split` (no static @licio/lcap-p2p import in apps/web) + the egress/applause gates extended over the new trees (15.8). **WS-R.15.4a native Android courier shell shipped:** `apps/courier/` (Capacitor 8, `webDir`→`apps/web/dist`) builds a real debug APK via `pnpm --filter courier build` (the two-stage `check-no-fork` byte-identity gate → `cap sync` → Gradle/Android-SDK), the CSP/Trusted-Types posture preserved in the WebView by the `index.html` `<meta>` CSP mirror, the `@capacitor/*` deps native-scoped (web budgets untouched), a `courier-apk` CI job (SDK from dl.google.com, no third-party action), and the doctrine gates extended over `apps/courier`. **WS-R.15.6a LIVE WebRTC establishment shipped:** `@licio/lcap-p2p` `connectWebrtc` drives a real `RTCPeerConnection` (offer/answer/trickled-ICE-with-pre-remote-description-buffering, datachannel-open wait, timeout/abort) over the sealed server-blind rendezvous (the wire codecs in `frame.ts` + the apps/web `createSignalClient`/`connectLcapWebrtc`); the relay-only `iceTransportPolicy` + Stealth/Emergency force-off are APPLIED to the live config, not merely decided.  Unit-tested against a faithful fake `RTCPeerConnection` PAIR (converge + byte exchange) AND a **real-Chromium-WebRTC datachannel loopback E2E** (`apps/web/e2e/webrtc-loopback.spec.ts`) confirms a real datachannel + byte path on the host.  **WS-R.15.4c native Nearby Connections plugin shipped:** `NearbyCourierPlugin.java` (advertise/discover/connect/send/receive, base64 bridge) registered in `MainActivity` + the per-API radio permissions (`neverForLocation`) + the `play-services-nearby` dep; the TS bridge `courier-native.ts` (CourierMedium over the INJECTED Capacitor global — no `@capacitor/core` npm dep; zod-validated fail-closed native boundary) + the WS-R.15.4e `decideCourierStart` control gating (off-by-default, Stealth/Emergency force-off).  `pnpm --filter courier build` produces a debug APK with the plugin compiled, through the no-fork byte-identity gate.  **WS-R.15.4f VERIFIED on emulated radios:** two headless emulators sharing the **netsim** virtual radio bus (RootCanal BLE/Bluetooth + virtio-wifi) exchange a Nearby Connections payload with NO internet — the SAME GMS API the plugin wraps — via `apps/courier/scripts/radio-e2e.sh` + `NearbyConnectionsRadioTest` (advertise→discover→connect→send, asserted byte-identical, reproducibly).  The courier APK also runs the byte-identical PWA on the emulator (the Capacitor WebView serves the `apps/web/dist` chunks from `https://localhost`), and the plugin registers + connects to the GMS Nearby Connections service.  Requires **KVM + a host GPU** (`-gpu host` — the bundled SwiftShader software renderer SIGSEGVs qemu during SurfaceFlinger bring-up on this CPU, so host-GPU rendering is mandatory; verified on an AMD Radeon/RADV host).  Remaining: the 15.4d additional native channels (Wi-Fi Direct / Bluetooth / USB — additional plugins on the proven Nearby pattern) + confirmation on PHYSICAL phones (the emulators validate the full code path; real radios add field confidence) |
| WS-R.17 — LCAP client surface | 17.1 – 17.3 | **Shipped** (`apps/web/src/lcap` + `apps/web/src/components/lcap`): the §34 honest trust/liveness label mapping (`trust-labels.ts`) + the `TrustBadge` (13 distinct labels, never one "secure"/"trusted"/"delivered" badge); the §33 operational modes (`operational-modes.ts` — minimal/standard/courier/relay/stealth/emergency, each defining storage policy + max priority + media + discovery/advertising/background-sync channels + export posture), with a persisted current-mode source (`mode-state.ts`) the **C0 sync already reads live** (Stealth suppresses the automatic sync + skips background-sync registration); the user-facing mode SELECTOR and the integration of the mode into the OTHER §33 consumers (media / export / discovery / storage posture) is a tracked follow-up — deliberately deferred so a Stealth control never ships ahead of the full posture it implies; the §25/§22.1.1/§20 offline-state surfaces (`OfflineStates/`: `ConflictWarning` — never-discard fork alert, `QuarantineNotice` — partial-import wait + `wants` fetch, `OutboxStatus` — honest queued/retrying/exported chip). These always-available surfaces mirror the state unions locally rather than importing `@licio/lcap` (pinned by completeness tests), so they stay off the lazy codec chunk apps/web loads it into for the WS-R.15.1 bundle flows. **Mounted where the state is REAL:** the `OfflineBundlePanel` import-done view renders `QuarantineNotice` from a real missing-dependency import AND the `TrustBadge` for the honest integrity-only trust the import actually grants (`integrity_verified`/`peer_stored` → "Cannot verify yet…", never a claim the projection has not made), proven end-to-end against a real bundle round-trip. Mounting badges on API-sourced story/room cards stays a tracked follow-up: those feeds are not yet driven from the `lcap_v2` store, so a badge there would carry no real per-record trust state (and the doctrine forbids a cosmetic trust signal) |
| WS-R.18 — tests, simulator, interop | 18.1 – 18.6 | **Shipped** — the deterministic discrete-event network simulator (`packages/lcap/src/test-vectors/sim`, R.18.3a/b): a seeded link model + pluggable adversaries (honest/withholding/flooding/equivocating) running the REAL scheduler + closure, with the named scenarios asserting the §32.3 metrics (C0 never starved, fork detection, quarantine-then-clear) + the §32.5 transport-independence property (R.15.9). The corpus / property / security legs (R.18.1/2/4) are the conformance-vector replay, the P1–P3 determinism properties, and the malleability/downgrade/bomb/rejection suites in the `@licio/lcap` suite. **R.18.5 browser↔Node crypto interop** ships as a dedicated Playwright spec (`apps/web/e2e/crypto-interop.spec.ts`): an @licio/lcap low-S signature verifies under raw browser WebCrypto (and its high-S malleability twin is accepted by WebCrypto but rejected by lcap), and a browser-WebCrypto signature verifies under lcap's strict verifier in Node — proving the wire signature bytes interchange in BOTH directions. **R.18.6 ships the §36 acceptance-gate checklist** (see below): 18 of 21 gates automated by a CI check or named test; the 3 manual/hardware gates are called out honestly |
| WS-R.16 — encryption envelope | 16.1 | **Shipped** — `EncryptedPayloadDescriptorV2` (§28.2) + `buildEncryptedPayloadBlock`/`verifyEncryptedPayloadBlock` (`packages/lcap/src/block/encrypted-payload.ts`): LCAP carries CIPHERTEXT + OPAQUE hints only (suite label / opaque `key_epoch_id` / `nonce` / `aad_context` commitment / ciphertext block CID), NEVER decodes the envelope, and the closed `.strict()` schema FORBIDS plaintext-equality hints for the group-keyed (`MLS-derived-AEAD`) suite (§10.6).  The authoritative key schedule stays in WS-S; the apps/web bundle bridge (private-p2p envelope → ciphertext block → `.licio-bundle`) is the tracked cross-plane follow-up |
| WS-S — Private P2P Rooms (E2EE) | all | Planned (`docs/PRIVATE_SPEC.md`) |

The pure-protocol core, the server ingestion + the full §29 route surface, the client
offline store, the privacy + DoS control plane (WS-R.14), the client surface (WS-R.17),
the client-local offline bundle export/import (WS-R.15.1a/b), and the **entire transport
plane over one `LcapTransport` seam** — the HTTPS anchor, WebTransport, courier, the
relay core, the code-split `@licio/lcap-p2p` (WebRTC + the dependency-free IPFS gateway
bridge), the QR micro-bundle, the server-blind signaling rendezvous, and the §32.3/§32.5
network simulator (WS-R.18.3), and the **WS-R.15.4a native Android courier shell**
(`apps/courier` — a Capacitor 8 shell building a real debug APK from the byte-identical
web build, CSP/TT preserved in the WebView, behind the `check-no-fork` gate + the
`courier-apk` CI job), the **WS-R.15.6a live WebRTC establishment** (`connectWebrtc` over
a real `RTCPeerConnection` + the sealed rendezvous, proven against a fake-peer pair AND a
real-Chromium-WebRTC loopback E2E), the **WS-R.15.4c native Nearby Connections plugin**
(compiled into the debug APK; the TS CourierMedium bridge + the WS-R.15.4e control gating),
and the **WS-R.16.1 encryption-envelope carrier** (`EncryptedPayloadDescriptorV2`,
ciphertext + opaque hints only) are complete.  The **transport-selection / operational-mode
UI is now mounted** (WS-R.17: the `OperationalModeSelector` at `/profile/mode`,
`TransportStatus`, the QR micro-bundle surface, with the §33 posture wired into the
offline-bundle export + discovery).  **WS-R.15.4f is VERIFIED on emulated radios** — two
headless emulators sharing the netsim virtual radio bus (RootCanal BLE/Bluetooth +
virtio-wifi) exchange a Nearby Connections payload offline, reproducibly, via
`apps/courier/scripts/radio-e2e.sh` + the `NearbyConnectionsRadioTest` instrumentation test
(needs KVM + a host GPU; `-gpu host` avoids the bundled-SwiftShader qemu crash).  The
WS-R.15.4d additional native radio channels (Wi-Fi Direct / Bluetooth / USB) ship as Java
plugins on the Nearby pattern AND are now SELECTABLE + driven from TS: `CourierController`
is channel-aware (`channels: CourierChannelPlugin[]`, each driven through the
`NativeChannelMedium`), and the `CourierRunner` UI (mounted at `/profile/mode`) exposes
per-channel toggles.  `syncRoomOverP2p` (the live LCAP WebRTC sync) is driven from the
`P2pSyncPanel` at `/profile/offline`; both carriers stay off the initial bundle (the
lcap-p2p chunk).  Remaining: the netsim radio E2E currently exercises only the Nearby
channel (Wi-Fi Direct / Bluetooth are netsim-reachable but not yet scripted); **USB is
TS-reachable but confirmable only on PHYSICAL OTG hardware** (no emulated USB bus —
surfaced in the `CourierRunner` copy + `COURIER_CHANNEL_INFO.usb.verification ===
'physical_only'`); and field confirmation on PHYSICAL phones (the emulated-radio E2E
validates the full Nearby code path; real radios add hardware confidence).  The apps/web
cross-plane bundle bridge (private-p2p ciphertext through an LCAP pack, WS-R.16.1 ↔
WS-S.6.5) is wired into `OfflineBundlePanel`.

### Ingestion-path hardening (external review, June 2026)

A deep external review of the WS-R server ingestion + bundle paths surfaced findings
across several waves.  **The fixed + tested set** spans the pure core (pack reader
table↔frame correspondence and table-cap decode, importer verified-frame dependency
set, validate event-size quota, and the wire `missing_cids`/`wants` kept CID-clean of
validate()'s identity pseudo-keys), the api routes (record-dependency `requires`,
CID-verified-proof gating, proof fan-in cap, Content-Length pre-buffer 413, repack
first-object budget, missing-dependency cap, the CSRF-protected signaling-drain POST,
**the device-certificate account-authority verification before key indexing (#7b)**, and
**the revocation authority + scope verification before indexing (#7)** via the new
`@licio/lcap` `verifyRevocationAuthority`, and **the server bundle export gated by a
device-signed, freshness-windowed `may_export_bundle` capability (#5)** via the new
`verifyExportAuthorization` — `GET /bundles/export` is now a CSRF-exempt, gated
`POST`), the web bundle import (standalone CID-verified chunk frames now persisted
CID-addressed instead of dropped, and re-import gated by the already-held set so it never
downgrades a record held at higher trust), and **the two gated-Postgres accept-path
concurrency races (#2/#3)**: the `(authorDeviceKeyId, deviceSeq)` claim is now an atomic
`claimDeviceSeq` (`INSERT … ON CONFLICT DO UPDATE`-to-a-no-op `… RETURNING cid`, so the
losing concurrent record is reported `conflict_device_fork`, never a second accept), and
`appendAcceptance` is idempotent + allocates the per-room seq atomically (insert at the
current count, retry on a `(room_id, seq)` PK collision; `.returning()` is non-empty only
on a real insert, so a phantom seq is impossible).  **All review findings are now fixed
+ tested** — the #2/#3 concurrency cases are in the parameterized store-contract test and
were validated against real Postgres (concurrent accepts get distinct, gap-free seqs;
concurrent claims admit exactly one winner).

A further completeness improvement made the §29.8 export **self-contained**: each record's
export closure now leads with the IDENTITY it needs to validate (its capability + the
signer's device certificate, each with authority proofs — a record→`identity` edge), so a
re-import into a server holding only the root-of-trust authority keys VALIDATES the
contribution rather than quarantining it (proven by a round-trip test against real
Postgres).

None of the above was launch-blocking (the LCAP server binding is gated/in-memory and
pre-production), and the pay-to-rank firewall + fail-closed crypto were unaffected
throughout.

**§27 ingestion-loop bounds — two further DoS fixes.**  The media-byte accounting work
indexes a contribution's SIGNED-BODY-declared block references (`body_block_cid` /
`attachment_manifest_cid` / `source_snapshot_cids`).  Unlike the pack TABLE deps (already
bounded by the §27.2 graph guard's `maxFanOut` and the §27.2 `maxGraphNodes` entry cap),
these body refs are NOT pack entries, so an unbounded `source_snapshot_cids` array (the
record schema sets no length) could otherwise drive an unbounded, AWAITED index-write loop
BEFORE signature validation — amplified on the durable store.  Two bounds close it: (1)
`indexBodyBlockEdges` rejects a contribution whose declared body-block-reference count
exceeds the §27.1 `maxFanOut` (`rejected_resource_limit`, nothing indexed) — the count is
checked before any parse, so an over-cap record costs O(1), and the §18.3 media charge +
the §29.8 closure stay bounded; (2) the whole parse+store+index phase
(`ingestPackFrames`) now runs under the §27.1 `maxCpuTimeMsPerImportBatch` budget
(`newImportBudget`), the same cap `commitBatch` already enforced on the commit phase — so a
large multi-object pack (its object COUNT bounded by the §27.2/byte caps, but its total
store/index writes still potentially O(10^5)) is wall-clock-bounded and cannot pin a worker.

**Aggregate capability quotas — shipped (all three).**  Beyond the per-event
`max_single_event_bytes` the §18.3 chain validator already enforced, the server now enforces
all three of a capability's *aggregate* quotas — `max_offline_events`,
`max_total_payload_bytes`, AND `max_media_bytes` — the stateful per-capability accounting a
pure, per-record `validate()` cannot hold.  A durable per-capability usage counter (event
count, total payload bytes, media bytes) lives on the `LcapServerStore` boundary
(`lcap_capability_usage`, migrations `0041` + `0042`); `acceptContribution` checks + debits all
three as ONE atomic step with the room-log append — idempotent by `record_cid` (a re-accept
never re-debits), the check + debit serialized per capability (the Drizzle adapter locks the
usage row `FOR UPDATE`, with an outer retry on the room-seq race; the in-memory adapter is
single-threaded), so concurrent accepts can never exceed any budget.  `commitRecord` routes a
fresh accept through this gate; an over-budget contribution (events, payload, OR media) is
`rejected_quota` (§16.11) and never appended (the device-seq claim stands; no budget is
debited).  Proven against real Postgres (within-budget accept, event-count / total-bytes /
media-bytes rejection, idempotent re-accept, a concurrent-accept cap at exactly the budget,
and the end-to-end `rejected_quota` wiring).

The `max_media_bytes` charge for a contribution is the summed ACTUAL stored size of the blocks
it references — its `block` edges (the §29.8 export closure index), derived tamper-resistantly
from BOTH the signed body's block references (`body_block_cid` / `attachment_manifest_cid` /
block-kind `source_snapshot_cids`) AND the pack table's declared block deps, de-duplicated.
The figure is always the server's own CID-verified byte length, never the author's declaration.
The server does not parse per-block roles, so every referenced block counts (the conservative
reading of §11.4 "referenced block sizes"; per-role weighting from the attachment-manifest
descriptors is a tracked refinement).  Media that ships in the contribution's own pack is
charged in full at accept (the §13.4 common case: the body/thumbnail/manifest blocks are P1/P2
and travel with the event); cross-pack lazy P3 media that arrives in a *separate* later pack
contributes 0 at accept and is otherwise bounded by the §27.1 block caps and the
`max_offline_events` count — retroactively charging a late block against an already-accepted
contribution's capability (a block→capability reverse index) is the remaining refinement,
tracked here.

## Acceptance gates (OFFLINE_SPEC §36 — WS-R.18.6)

§36 enumerates the gates that must hold before LCAP v0.2 is production-ready for
**high-risk use**.  Each gate below maps to a CI check or a named test.  The gates
that require **physical hardware** or an **external full-plane review** are called
out explicitly as manual/pending so no false "secure" claim is implied — the LCAP
server binding is gated/in-memory and pre-production regardless.

| # | §36 gate | Mechanism | Status |
|---|---|---|---|
| 1 | `record_cid` / proof separation | Detached COSE_Sign1 proofs over CID-addressed records; strict closed schemas (`packages/lcap/src/{schemas,cose/sign1.ts}`) | ✅ Automated (`pnpm --filter @licio/lcap test`) |
| 2 | Deterministic encoding vectors stable | LDC golden corpus + the P1–P3 determinism properties (`packages/lcap/src/test-vectors`, `__tests__`) | ✅ Automated |
| 3 | Browser ↔ Node crypto interop | `apps/web/e2e/crypto-interop.spec.ts` (Playwright, all three engines) + the Node COSE suite | ✅ Automated (CI E2E job) |
| 4 | Malformed-pack fuzz | Packfile cap/tamper matrix + the §27.2 dependency-bomb corpus (`limits/__tests__`) | ✅ Automated |
| 5 | C0-starvation | `pnpm check:lcap-scheduler` + the simulator "C0 never starved" scenario (`test-vectors/sim`) | ✅ Automated (named CI gate) |
| 6 | Outbox durability | Liveness / receipts / outbox model (WS-R.10) + the client IndexedDB durability layer (`apps/web/src/lcap/store.test.ts`, WS-R.11.3b) | ✅ Automated |
| 7 | Revocation propagation | §18.3 chain-validator revocation matrix + the simulator revocation race | ✅ Automated |
| 8 | Checkpoint consistency | RFC 9162 inclusion/consistency suite (WS-R.9) + `apps/api/src/__tests__/lcap-checkpoint-issuance.test.ts` | ✅ Automated |
| 9 | UI trust labels reviewed | §34 honest label SSOT + `TrustBadge` (13 labels — no single "secure"/"trusted"/"delivered"); mapping pinned by `trust-labels.test.ts` | ✅ Automated mapping + code-review sign-off |
| 10 | No raw attention / IP / location in LCAP schemas | `pnpm check:lcap-schema-egress` (CI lint job) | ✅ Automated (named CI gate) |
| 11 | Storage-pressure behavior on low-end Android | §21.3 storage-mode + pressure-degradation units (`apps/web/src/lcap/storage-modes.test.ts`) | ⚠️ Logic automated; an emulator harness now exists (WS-R.15.4f), so on-emulator verification is possible — real low-end-device confirmation is the remaining field check |
| 12 | Import / export privacy warnings | §26.2 disclosure-before-file + §26.3 high-risk filename (WS-R.14.2) + the `OfflineBundlePanel` pre-render summary | ✅ Automated |
| 13 | External threat-model review | Ingestion + bundle paths externally reviewed (June 2026; see above) | ⚠️ Ingestion/bundle reviewed; the **full-plane** external review is a launch gate for high-risk use |
| 14 | Private-room replication disabled or audited | No WS-S private plane exists yet; the §21.4 replication gate excludes non-public content | ✅ Disabled (re-audit when WS-S lands) |
| 15 | One `validate` / `LcapTransport` seam | §22.6 seam + the single server-side `validate()`; `pnpm check:lcap-p2p-split` | ✅ Automated (named CI gate) |
| 16 | Correctness-independent-of-transport | The §32.5 transport-independence property in the simulator (WS-R.15.9) | ✅ Automated |
| 17 | No peer IP / multiaddr / radio identifier in any LCAP schema | `pnpm check:lcap-schema-egress` over `@licio/lcap-p2p` + `apps/courier` | ✅ Automated (named CI gate) |
| 18 | WebRTC/IPFS deps code-split + workspace-excluded | `pnpm check:lcap-p2p-split` + the < 200 KB-gz initial-bundle gate + `pnpm check:deps` (web < 15) | ✅ Automated (named CI gates) |
| 19 | IPFS publishes public blocks only | The bridge's public-only publish gate, CID-re-verified on BOTH the fetch and publish paths (WS-R.15.7b) | ✅ Automated (takedown-driven republication-halt wiring tracked) |
| 20 | P2P/courier reach off by default; off in Stealth/Emergency | §33 operational modes + the §26.4 ICE off-by-default / Stealth-force-off policy | ✅ Automated |
| 21 | `apps/courier` native build green in CI | The `courier-apk` CI job (debug APK from the byte-identical web build, behind `check-no-fork`); the APK additionally RUNS on an emulator (the WebView serves the `apps/web/dist` chunks + the `NearbyCourier` plugin connects to GMS Nearby) and the WS-R.15.4f two-emulator Nearby exchange passes over emulated radios (`apps/courier/scripts/radio-e2e.sh`) | ✅ Automated (CI APK build); emulator run + radio E2E reproducible on a KVM + host-GPU host |

**Net:** 18 of the 21 gates are enforced by an automated CI check or a named test, and
the **WS-R.15.4f courier radio E2E is additionally verified on emulated radios** (two
netsim-bridged emulators exchange a Nearby Connections payload offline — see gate 21 and
`apps/courier/scripts/radio-e2e.sh`; reproducible on a KVM + host-GPU host).  The remaining
honest manual/hardware gates: real low-end-**device** storage-pressure confirmation (gate
11) and the **full-plane** external threat-model review (gate 13) are pre-production launch
gates, and IPFS takedown-driven republication-halt (gate 19) is a tracked wiring follow-up.
No part of the LCAP plane claims "secure" for high-risk use ahead of gates 11 and 13.
