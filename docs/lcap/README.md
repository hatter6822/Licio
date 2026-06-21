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
- the §29.8 `GET /api/lcap/v2/bundles/export?room=…` — a room's content closure (its
  accepted records, each followed by its proofs then its referenced blocks) repacked
  from held bytes via an import-captured record→proof/record→block closure index
  (`indexRecordEdge`/`recordEdges` over migration `0040`); UNSIGNED (each record
  self-authenticates via its included proof), re-importable, generic filename.

The remaining WS-R cards are **I/O integration** — the WS-R.15.1a bundle-export UI
flow (the server `GET /bundles/export` is shipped; the authority-signed checkpoint
record is checkpoint issuance), the transport profiles (WS-R.15), the WS-S
encryption-envelope seam (WS-R.16), the client surface (WS-R.17), and the network
simulator (WS-R.18) — plus the entire WS-S private-rooms plane.  Those bind this pure core to Postgres / IndexedDB /
Hono / the browser and are **not yet started** (see "Status" below).  The optional,
non-authoritative set-reconciliation filters (WS-R.7.3) are deferred by the spec itself.

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
| WS-R.9 — Merkle / checkpoint / inclusion / consistency / witness | 9.2 – 9.4 | **Shipped** (9.1 server-append logic core; DB binding in WS-R.12) |
| WS-R.10 — liveness, receipts, durable outbox | 10.1 – 10.3 | **Shipped** (IndexedDB binding in WS-R.11) |
| WS-R.13 — conflict dispatch + visible-thread projection | 13.1 – 13.2 | **Shipped** |
| WS-R.12 — server ingestion | 12.1, 12.2, 12.4 | **Decision core + §24.4 resolver + server-computed validation + in-memory & gated-Drizzle bindings + the full §29 route surface shipped** (`ingestRecord`, `resolveIngestionOrder`, `validate`; `apps/api/src/lcap` `LcapIngestServer` incl. `validateContribution`/`commitBatch`/frontiers/room-Merkle reads; `routes.ts` content reads + `POST …/packs` + `/pulse` (incl. C0 `critical_pack`) + `/exchange` (incl. `response_pack`) + `/rooms/:id/{checkpoint,proofs/*}` + `/bundles/import` + `GET /bundles/export` (room closure via the migration-`0040` closure index); the `LcapServerStore` boundary over migrations `0039`+`0040`) — **§29 route surface complete**; only the WS-R.15.1a export UI flow remains of 12.4 |
| WS-R.14 — privacy + DoS controls | 14.1a, 14.1b, 14.2, 14.3, 14.4 | **Shipped**: the §27.1 resource-cap SSOT (`limits/caps.ts` — one frozen config every parser path sources, profile-tunable/never-disable-able, `checkCap`/`enforceCap`; the server parse enforces the CPU-time + quarantine-byte caps, 14.1a); the §27.2 graph guard run over the pack's DECLARED DAG before storage (14.1b); the §27.3 relay quotas + §27.4 no-PoW/no-address policy (`limits/relay-quota.ts`, 14.4); the §26.2 export-disclosure + §26.3 stealth policy (`privacy/`, 14.2 — interest-privacy in R.6.3); the §3.7/§36 doctrine CI gates (`check:lcap-schema-egress` + no-applause/no-raw-egress over the LCAP trees, 14.3). The 14.2 export UI flow is WS-R.15.1a |
| WS-R.11 — IndexedDB client offline store | 11.1 – 11.5 | **Shipped** (`apps/web/src/lcap`: `lcap_v2` schema + durability + pinning/eviction + storage modes + C0-first sync + replication gate); durability layer / SW hooks = follow-up |
| WS-R.15/R.16/R.17/R.18 — transports, encryption envelope, client UI, simulator | — | Planned |
| WS-S — Private P2P Rooms (E2EE) | all | Planned (`docs/PRIVATE_SPEC.md`) |

The pure-protocol core is complete; the next slices bind it to infrastructure —
the `lcap_v2` IndexedDB store (WS-R.11), the Hono `/api/lcap/v2/*` ingestion +
reconciliation routes over the `packages/db/src/schema/lcap.ts` schema
(WS-R.12), and the sync pulse/exchange wire orchestration (WS-R.6/R.7).
