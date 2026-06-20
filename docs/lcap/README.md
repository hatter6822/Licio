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
WS-R.0 protocol foundation** — the `@licio/lcap` record + trust-plane core that
every later card builds on. The sync plane, transport profiles, server/web
integration, packfiles, lane scheduler, and the WS-S private-rooms plane are
**not yet started** (see "Status" below).

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
    ├── index.ts                 -- public surface (cbor / cid / cose / schemas)
    ├── runtime.ts               -- WebCrypto adapter + BufferSource helper (no node: leak)
    ├── cbor/                     -- LDC deterministic CBOR (encode, decode, errors, types)
    ├── cid/                      -- CID construction + RFC 4648 base32
    ├── cose/                     -- aad, ecdsa (low-S), keys, suites, sign1 (build + verify)
    ├── schemas/                  -- strict zod records/proofs + the LDC codec pairing
    ├── test-vectors/             -- normative golden corpus (cbor/cid/sign1 .json)
    └── __tests__/                -- unit + conformance-replay + determinism property suites
```

## Testing

`pnpm --filter @licio/lcap test` runs the suite standalone (10 files, 83 tests at
the time of writing): per-major-type byte assertions and the §9.1.5 integer table,
the full decode rejection matrix with offsets, CID known-answer grounding
(SHA-256 of "" and "abc"), the ES256 low-S boundary matrix and the malleability
twin, COSE_Sign1 multi-proof identity and the six-step verifier matrix, strict
schema rejection + version routing, the conformance-corpus replay, and the
P1/P2/P3 determinism properties. Package coverage is comfortably above the 80%
global gate.

Browser↔Node crypto-interop vector replay (the gated WS-R.0.5b leg) is wired
through the same committed vectors; a Playwright/WebCrypto cross-runtime harness
is a later card (the package is already runtime-agnostic via `runtime.ts`).

## Status

| Area | Cards | Status |
|---|---|---|
| WS-R.0 — foundations (encoding, CID, COSE/ECDSA, schemas) | 0.1 – 0.8 | **Shipped** (`packages/lcap`) |
| WS-R.1 — identity, certificates, capabilities, revocations | 1.1 – 1.5 | Planned (schemas exist; consumption/validation services not yet) |
| WS-R.2 – R.18 — record graph, blocks, packs, scheduler, sync, trust projection, transports, client/server integration | — | Planned |
| WS-S — Private P2P Rooms (E2EE) | all | Planned (`docs/PRIVATE_SPEC.md`) |

The next card up the dependency graph is **WS-R.1** (the identity chain:
device-certificate authority proofs, capability consumption + the device-sequence
hash chain, revocation scheduling, and `validateIdentityChain`), which consumes
the WS-R.0 primitives directly.
