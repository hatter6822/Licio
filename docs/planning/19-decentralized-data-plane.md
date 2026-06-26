# The Decentralized Data Plane — Offline Content Availability (WS-R / LCAP v0.2) and Private P2P Rooms (WS-S / E2EE)

**Status:** the two post-WS-Q decentralization workstreams, unified into one upgrade. | **Milestone:** M3+ core resilience & privacy — **WS-R is elevated to launch-relevant (P1)** by the 2026-06 maintainer decision (first-class native-courier + browser-P2P/WebTransport/IPFS transports); **WS-S** remains a post-M3 privacy extension (P3, separate storage/sync/trust/authority plane). | **Priority:** P1 (WS-R) · P3 (WS-S) | **Dependencies:** WS-C/D/E/F/G/Q (all complete) for both planes; WS-S additionally consumes **WS-O** (reproducible builds + transparency log) for its update channel. | **Source specs:** `docs/OFFLINE_SPEC.md` (LCAP v0.2 → Part I / WS-R) and `docs/PRIVATE_SPEC.md` (→ Part II / WS-S). | **Waves:** WS-R Wave 8 (pulled earlier; elevated), WS-S Wave 11 (parallelizable with WS-R — independent except the optional LCAP-pack CAR reuse). | **Estimated duration:** WS-R 16–22 weeks, WS-S 18–24 weeks (parallelizable with two teams; ~30–40 weeks single-team sequential). | **Task count:** 171 atomic cards (Part I / WS-R: 104 · Part II / WS-S: 67) — the original 161 with nine bundled cards intelligently decomposed into smaller, independently-testable sub-cards (+10).

> This document **supersedes and replaces** the two former planning documents `19-offline-content-availability.md` (WS-R) and `20-private-p2p-rooms.md` (WS-S). All `WS-R.*` and `WS-S.*` card IDs, spec references (`Ref:`), acceptance criteria, and testing notes are preserved **verbatim**; only the surrounding framing is unified. The two source specifications (`docs/OFFLINE_SPEC.md`, `docs/PRIVATE_SPEC.md`) remain the normative sources and are unchanged by this merge.

> **Implementation status (current).** The **entire pure-protocol core of WS-R is COMPLETE** — shipped as the new zero-npm-dependency-core `@licio/lcap` workspace package (conformance-vector-pinned). Complete slices: **WS-R.0** foundations (the LDC deterministic-CBOR codec + conformance corpus, CID construction + base32, the COSE_Sign1 detached-proof envelope with ES256 low-S canonicalization, device-key/COSE_Key handling + the runtime adapter, downgrade-resistant suite agility, strict closed-schema records/proofs paired with LDC decode); **WS-R.1** the identity chain (device certificates, room capabilities, the device-sequence hash chain, the revocation index, and the §18.3 steps-6-11 `validateIdentityChain`); **WS-R.2** the record graph (contribution→operation mapping, the append-only edit/tombstone projection, display ordering, device-fork detection); **WS-R.3** blocks, fixed-size chunking/reassembly, attachment laziness, and Compression-Streams gzip/deflate with bomb caps; **WS-R.4** the packfile / `.licio-bundle` format (streaming writer/reader, partial import + quarantine, the signed manifest); **WS-R.5** the anti-starvation lane scheduler (byte reservations, deficit-round-robin, the clamped finite score) behind the new `check:lcap-scheduler` CI gate; **WS-R.6** the transport-independent sync-decision plane (the pulse + frontier diff, exchange request/response assembly, resource/privacy budget shrinking, privacy-scoped interests, wants + resumable range fetch, and idempotent-ingestion keying); **WS-R.7** reconciliation (the §17.1 frontier-first order and the §17.5 `minimalClosure` the scheduler consumes; the optional set-reconciliation filters of WS-R.7.3 are deferred by the spec); **WS-R.8** the single `validate(record)` trust-projection entry point over the §18.2 state lattice; **WS-R.9** the RFC 9162 Merkle / checkpoint plane (inclusion + consistency proofs, witnesses, fork evidence); **WS-R.10** the liveness / receipts / durable-outbox model; **WS-R.13** the §25.1 conflict-table dispatch + the trust/safety-aware visible-thread projection; and **WS-R.12.1** the server-ingestion commit-stage decision core (`ingestRecord` — idempotency + the shared `validate()` projected through the §25.1 conflict table + the §24.2 room-log-append gate + receipts + missing-dependency wants) plus the **WS-R.12.1b** §24.4 topological ingestion-order resolver (`resolveIngestionOrder` — prerequisites-before-dependents order with cert/capability/revocation/checkpoint/moderation class priority, transitively-absent missing-dependency detection, and declared-cycle isolation), now bound in `apps/api/src/lcap/server-ingest.ts` (`LcapIngestServer` — CID-verified CAS + the per-room acceptance log + authoritative idempotency/fork detection + **server-computed `validateContribution`** (the same `validate()` the client uses, over registered device certs / room capabilities / account+room authority keys / revocations — never a client-supplied verdict) + `commitBatch` ordered batch ingestion, WS-R.12.1a/b/c; durable state behind the **`LcapServerStore`** async boundary, `store.ts`), with the **WS-R.14.2** §27.2 malicious-dependency-graph guard (`checkDependencyGraph` — cycle/fan-out/depth/duplicate-dependency/private-in-public/unknown-critical-field detectors, node-count-capped first so the guard is itself bounded) wired in ahead of any expansion. See `docs/lcap/README.md` for the per-card mapping and `packages/lcap/` + `apps/api/src/lcap/` for the code. The **WS-R.12.4 §29 route surface is shipped** (`apps/api/src/lcap/routes.ts` + the `service.ts` singleton, mounted in `app.ts` through the global security middleware, all with the §22.1.1 status mapping): the content-READ endpoints (`GET /api/lcap/v2/{records,proofs,blocks}/:cid`, with RFC 7233 resumable range/206 + 416 reads); the CSRF-exempt, rate-limited pack-import `POST /api/lcap/v2/packs` (read under the WS-R.4.2 caps → every CID-verified frame durably stored so its proofs/blocks are fetchable via the GET routes → identity frames registered → contributions committed through validate→guard→commit → one §16.11 status per object) + the §29.8 `POST /api/lcap/v2/bundles/import` web alias (the SAME validator, CSRF-protected — a session-bearing browser flow keeps the token) + the §29.8 `GET /api/lcap/v2/bundles/export?room=…` (a room's content closure — records + each record's proofs + referenced blocks — repacked from held bytes via an import-captured record→proof/record→block closure index over migration `0040`, UNSIGNED + re-importable); the §29.1 `POST /api/lcap/v2/pulse` C0 frontier exchange + the §29.2 `POST /api/lcap/v2/exchange` main bidirectional path (both returning the server's §17.2/§17.3 frontiers — per-room checkpoint tree sizes keyed by the shared `roomIdHash`, the global revocation epoch — AND serving the peer's explicit wants as a budget-bounded content pack: the pulse's C0 `critical_pack`, the exchange's `response_pack`, repacked from held bytes with content-derived §15.1.1 lane/priority hints + a conservative privacy label, `partial` when a held want is dropped for the response budget; the exchange also ingests its optional push pack through the shared validator → `accepted_push` and derives `wanted_from_client` from the server's own frontier diff, `applyPulse`); and the §29.7 room reads `GET /api/lcap/v2/rooms/:roomId/{checkpoint,proofs/inclusion,proofs/consistency}` (the unsigned tree head + RFC 9162 inclusion/consistency proofs over the §19.1 room log reconstructed from the canonical acceptance order, the served proofs verifying against an independently-built log). The **WS-R.12.2** `LcapServerStore` boundary is shipped with BOTH adapters — the async store interface (CAS + acceptance log + device-seq + fork evidence), the in-memory adapter, and the gated **Drizzle/Postgres adapter** (`apps/api/src/lcap/drizzle-store.ts` over the four `lcap_*` tables in migration `0039`, DATABASE_URL-gated, selected in `service.ts`), proven interchangeable by the parameterized store-contract integration test. The **WS-R.11 client offline store is complete** in `apps/web/src/lcap`: the `lcap_v2` IndexedDB schema (12 §23.1 stores + indexes + versioned migration, a SEPARATE database from the WS-C `licio` store with a static isolation check, WS-R.11.3a); the §23.2 durability layer (cursor-only streaming, blob↔metadata separation, atomic verified-record commit, capped transactions, quota-retry, WS-R.11.3b); the §21.2 pinning/eviction policy (WS-R.11.1); the §21.3 storage modes + pressure degradation (WS-R.11.2); the §23.3 C0-first sync orchestration (WS-R.11.4); and the §21.4 privacy-aware replication gate (WS-R.11.5). **WS-R.14 privacy + DoS controls is shipped**: the §27.1 resource-cap SSOT (`limits/caps.ts` — one frozen config every parser path sources, profile-tunable but never disable-able, the `checkCap`/`enforceCap` helper; the server parse enforces the §27.1 CPU-time + quarantine-byte caps, R.14.1a); the §27.2 malicious-graph guard now run over the pack's DECLARED dependency DAG before any storage (R.14.1b); the §27.3 relay admission quotas + the §27.4 no-PoW/no-client-address policy (`limits/relay-quota.ts`, R.14.4); the §26.2 export-disclosure + §26.3 stealth-mode policy (`privacy/`, R.14.2 — the interest-privacy half shipped with R.6.3); and the §3.7/§36 LCAP doctrine CI gates (`check:lcap-schema-egress` + no-applause/no-raw-egress extended over the LCAP trees, R.14.3).  The **WS-R.15.3 untrusted-relay decision core is shipped** (`apps/api/src/lcap/relay.ts` `LcapRelay`: a content-addressed cache that stores/serves by CID, returns storage receipts, enforces the §27.3 quotas + private-content refusal, and STRUCTURALLY cannot accept — no room-log/commit surface; §19.1 opaque peer keys).  The **WS-R.17 client surface is shipped** (`apps/web/src/lcap` + `apps/web/src/components/lcap`): the §34 honest trust/liveness label mapping (`trust-labels.ts`) + the `TrustBadge` (13 distinct honest labels — never one "secure"/"trusted"/"delivered" badge; hard verdicts cap any propagation claim, otherwise the furthest honest reach, R.17.1); the §33 operational modes (`operational-modes.ts` — minimal/standard/courier/relay/stealth/emergency, each driving the §21.3 storage policy + the max priority class + media + the discovery/advertising/background-sync channels + the export posture, R.17.2); and the §25/§22.1.1/§20 offline-state surfaces (`OfflineStates/`: `ConflictWarning` — the never-discard device-/checkpoint-fork alert, `QuarantineNotice` — the partial-import wait + the §16/§17 `wants` fetch, `OutboxStatus` — the honest queued/retrying/exported chip, R.17.3); these always-available surfaces mirror the state unions locally rather than importing `@licio/lcap` (pinned by completeness tests), so they stay off the lazy codec chunk.  The **WS-R.15.1a/b client-local offline bundle export/import is shipped** (`apps/web/src/lcap/bundle-{export,import}.ts` + the `OfflineBundlePanel` + the `/profile/offline` route): the REAL @licio/lcap pack writer (R.4.1) / reader (R.4.2) run in the browser, loaded as a LAZY dynamic-import chunk so the initial bundle is untouched (apps/web now takes @licio/lcap, a `workspace:*` dep outside the <15 budget); export gathers a room's record→proof→block closure + shows the §26.2 disclosure before producing a file + a generic high-risk filename (§26.3); import reads under the §27.1 caps with typed rejection + a pre-render summary + missing-dependency quarantine (R.4.3), committing at INTEGRITY-ONLY trust so nothing renders before trust projection (R.8.3).  The **WS-R transport plane is shipped over ONE `LcapTransport` seam** (`packages/lcap/src/transport`, R.15.4b): the byte-channel interface every carrier implements + the selection policy that forces a server-mediated transport LAST (the always-correct anchor) + the public-only carriage gate (`transportMayCarry`) + the fallback driver.  The client carriers (`apps/web/src/lcap/transports`): the **HTTPS anchor**, the platform **WebTransport** adapter + feature-detect (R.15.5), the **courier** ferry over a `CourierMedium` (R.15.4b; the native Nearby/BLE channels ride the same adapter behind the deferred Capacitor shell), and the **registry** running `fallbackExchange` with the optional WebRTC carrier loaded by a DYNAMIC `import('@licio/lcap-p2p')`.  The new code-split **`@licio/lcap-p2p`** package (workspace-deps allow only `@licio/shared` + `@licio/lcap`): the **WebRTC** data-channel transport + the **server-blind AES-GCM signaling envelope** (AAD-bound to room/from/to; the server forwards opaque bytes only) + the §26.4 **ICE/NAT-privacy policy** (off by default, Stealth/Emergency force-off, relay-only-requires-TURN, IP-exposure disclosure) (R.15.6a/b); and the **DEPENDENCY-FREE IPFS gateway bridge** — the verification-preserving `block_cid ⇄ CIDv1(raw 0x55, sha2-256)` map (hand-rolled multibase), re-verify-before-use (no transport trust), public-only publish (R.15.7a/b) — the maintainer-approved posture instead of Helia/libp2p.  The **§22.3 QR micro-bundle** (`apps/web/src/lcap/transports/qr`, R.15.2): a hand-rolled byte-mode encoder (GF(256) Reed–Solomon, versions 1–4 EC-L, lowest-penalty mask), proven CORRECT by a jsQR round-trip, + lazy jsQR still-image decode (no camera; Apache-2.0, zero transitive deps, no install scripts — the user-approved dependency).  Server: the **server-blind `POST/GET /api/lcap/v2/p2p/signal`** rendezvous (a capped store-and-forward mailbox that never decodes the blob; a §19.1 static check, R.15.6a).  Governance (R.15.8): the `check:lcap-p2p-split` gate (apps/web imports `@licio/lcap-p2p` only dynamically — the protocol code stays out of the initial bundle, held at 166KB) + the egress/applause gates extended over the new trees.  And the **§32.3/§32.5 deterministic network simulator** (`packages/lcap/src/test-vectors/sim`, R.18.3a/b): a seeded link model + pluggable adversaries (honest/withholding/flooding/equivocating) running the REAL scheduler + closure, with the named scenarios asserting C0-never-starved, fork-detection, quarantine-then-clear, and the transport-independence property (R.15.9); the corpus/property/security/interop legs (R.18.1/2/4/5) are the conformance-vector replay + determinism/malleability/downgrade/bomb suites already in the `@licio/lcap` core.  The **WS-R.15.4a native Android Capacitor courier shell is now shipped**: `apps/courier/` is a Capacitor 7 Android project (`appId app.licio.courier`) whose `webDir` points DIRECTLY at the canonical `apps/web/dist`, so there is structurally no courier-only web fork; `pnpm --filter courier build` runs the two-stage `check-no-fork` integrity gate (structural: the courier carries no web-app source of its own; byte-identical: every file of the web build is byte-for-byte present in the synced WebView assets, only the Capacitor bridge shims added) → `cap sync` → a real **debug APK** via Gradle 8.11.1 + the Android SDK (platform-35 / build-tools 35.0.0 from dl.google.com).  The CSP / Trusted-Types posture SURVIVES the WebView: the web `index.html` now also carries a `<meta>` mirror of the server `Content-Security-Policy` (the enforceable-in-meta directives — `script-src 'self'` / `object-src 'none'` / `base-uri 'self'` / `trusted-types … ` / `require-trusted-types-for 'script'`), redundant with the header on the web (identical policy → no behaviour change, proven by the chromium routing + UGC-safety e2e) and the SOLE CSP source in the courier's `https://localhost` WebView.  The `@capacitor/*` deps are confined to `apps/courier` (build/native scope — the web `<15` dep budget and the `<200 KB` initial-bundle gate are untouched); a new `courier-apk` CI job installs the SDK from dl.google.com (no third-party action) and builds the APK; the §3.7/§36 doctrine gates (`check:no-applause` / `check:no-raw-egress` / `check:lcap-schema-egress`) now scan `apps/courier`.  The **WS-R.15.6 live LCAP P2P transport is now driven + fragmented**: `syncRoomOverP2p` (`apps/web/src/lcap/transports/sync-over-p2p.ts`) is the FIRST real runtime consumer of the WebRTC carrier — it derives a PUBLIC signaling key by HKDF over the public `roomIdHash` (`signal-key.ts`; the WS-S engine never imports it), establishes a live `WebrtcTransport` over the server-blind rendezvous, and runs ONE §16 exchange through `offlineExchange` so the HTTPS anchor stays LAST (anchor-last + public-only carriage preserved); `@licio/lcap-p2p`'s `webrtc/fragment.ts` (`fragmentMessage`/`FragmentReassembler`) carries ≤ 16 KiB SCTP-safe fragments with fail-closed reassembly + the 16 MiB §27 DoS bound. **WS-R.16.1 the cross-plane bundle bridge is shipped** (`apps/web/src/lcap/cross-plane-bridge.ts` — `exportPrivateEnvelopesToBundle`/`importBundleToPrivateEnvelopes`): a WS-S `PrivateEncryptedEnvelope` rides inside an LCAP `.licio-bundle` as an opaque `encrypted_payload` block (suite `MLS-derived-AEAD`, so the §28.2 schema forbids any plaintext hint, §10.6); LCAP re-hashes the CID + re-parses through the private-p2p envelope schema and never decrypts (§8.3). **The WS-R.15.4c/d/e native courier is driven end-to-end**: `apps/web/src/lcap/transports/courier-controller.ts` (`CourierController`) runs the Nearby plugin to actual byte exchange (off-by-default; Stealth/Emergency force-off via `decideCourierStart`; public-only carriage), all four §22.5 controls + the radio-metadata-disclosure ack gate (`courier-controls-state.ts`) rendered by the `CourierControls` UI (advertise/discover toggles disabled until acknowledged), and three new Java plugins compiled into the debug APK — `WifiDirectCourierPlugin.java` (Wi-Fi Direct, netsim-verifiable), `BluetoothCourierPlugin.java` (Classic RFCOMM + BLE-GATT fallback, netsim-verifiable), `UsbCourierPlugin.java` (USB accessory mode, physical-OTG-only). **WS-R.15.4f is re-verified** — the two-emulator Nearby radio E2E (`apps/courier/scripts/radio-e2e.sh`) still passes with the rebuilt APK carrying the three new plugins. **Gate-19 (WS-R.15.7b / WS-S.4.4) is closed — the FULL §22.7 gate**: the **required privacy/moderation/abuse-REVIEW gate** (`apps/api/src/lcap/review-gate.ts` over `lcap_block_publish_review`, migration `0049` — a public block reaches the DHT only if every source content entity is `approved`; an unreviewed/pending/rejected/source-less candidate is refused `review_required`; an unreadable review store fails closed; a steward records the decision through `POST …/public-bridge/review`), the live-takedown re-check (`takedown-oracle.ts` `DrizzleTakedownOracle`, fail-closed) over the `lcap_block_provenance` linkage (migration `0046`) recorded UNCONDITIONALLY from a now-mandatory `content_targets`, **STEWARD-AUTHORIZED** routes (`authMiddleware()` + steward-role + MFA on `POST …/public-bridge/{publish,republish,review}`), and ONE **append-only audit row per (re)publish decision** (`publish-audit.ts` / `lcap_publish_audit`, migration `0049`, append-only trigger) — so the gate decision is durably auditable; `@licio/lcap-p2p` is an `apps/api` dependency (the DB binding it cannot import itself).  The §22.5 courier + the §22.6 WebRTC carrier are FULLY FUNCTIONAL bidirectional, secure P2P transports: the WS-R.15.10 client §16 exchange engine (`apps/web/src/lcap/exchange.ts` + `webrtc-sync.ts`) makes content MOVE — both peers serve each other's `want`s, ingest the served/pushed packs (CID-verified, integrity-only trust, public-only), and gossip their own public content out — anchor-backstopped.  The remaining WS-R work is purely hardware confidence on PHYSICAL phones/radios (the netsim + headless real-WebRTC E2E already validate the full code path); that is a validation activity, not a code gap.

---

## Overview — two planes, one upgrade

This is Licio's **Decentralized Data Plane** upgrade. It takes content out of the main server's *exclusive* custody along two complementary, deliberately-separated planes that share a content-addressed, fail-closed, doctrine-respecting substrate but **never share keys** and **pin different crypto suites on purpose**.

- **Part I — WS-R / LCAP v0.2 (availability & transport plane).** Content stays *server-visible but portable*: deterministic, content-addressed record bodies (`record_cid`) carry **detached ES256 proofs** and reconcile into the same canonical server room/thread state regardless of how they arrive — HTTPS, manual `.licio-bundle`, QR, local relay, WebTransport, WebRTC P2P, a browser IPFS public-block bridge, or a native Capacitor courier. LCAP optimizes **useful verified availability per cost** under intermittent connectivity, hostile networks, cheap phones, and incomplete trust, and guarantees that tiny trust/liveness objects always move before media. (`docs/OFFLINE_SPEC.md`.)
- **Part II — WS-S / Private P2P Rooms (confidentiality & authority plane).** Content becomes *server-invisible*: a third room class `private_p2p` whose content, threads, comments, media, membership internals, and private search state are **end-to-end encrypted and hosted by members' devices**, keyed by **MLS**, behind a structural **server non-storage contract** — platform staff can never read, alter, recover, moderate, add members to, or delete it because the platform never possesses content, keys, heads, or authoritative membership. (`docs/PRIVATE_SPEC.md`.)

They **compose at exactly one seam**: LCAP transports WS-S **ciphertext + opaque hints** (the `.licio-bundle` MAY serve as WS-S's encrypted CAR), but LCAP never sees plaintext, keys, op-heads, or real private-room ids; WS-S never lets a server-visible record carry private content. **Either plane is useful and shippable without the other.**

## The two planes at a glance

| | Part I — WS-R / LCAP | Part II — WS-S / Private P2P |
|---|---|---|
| Concern | Availability & transport | Confidentiality & authority |
| Server can read content? | **Yes** (server-visible, content-addressed, reconciles to the canonical room log) | **No** (structural server non-storage contract) |
| Storage | Server + portable packs/pins | Member devices / encrypted pins |
| Identity / signing suite | **ES256** (P-256), detached COSE_Sign1 proofs | **Ed25519 + MLS (RFC 9420) + HPKE (RFC 9180)** |
| Content addressing | LCAP CID over the **signed plaintext** body (proof bytes excluded) | CIDv1 / IPLD over **ciphertext** (encrypt-before-CID; no plaintext CID ever) |
| Source spec | `docs/OFFLINE_SPEC.md` | `docs/PRIVATE_SPEC.md` |
| New package(s) / shell | `packages/lcap`, `@licio/lcap-p2p`, `apps/courier` | `packages/private-p2p` |
| Cards | 104 (WS-R.0 – WS-R.18) | 67 (WS-S.0 – WS-S.11) |

## Shared foundations and the single composition seam

Both planes are almost entirely net-new code that touches the running app only at well-defined seams, and both inherit Licio's doctrine in full. The genuinely-shared substrate (factored here **once**; each Part keeps its plane-specific detail and conventions):

1. **Crypto-suite separation & key non-sharing (ABSOLUTE).** The two planes pin **different** suites on purpose — ES256/P-256 for LCAP record proofs; Ed25519 + MLS + HPKE for WS-S group/authority — and **never share keys or signers**. LCAP device keys, WS-S MLS group keys, and the WS-D account/room **authority** keys are distinct hierarchies with distinct lifecycles; neither plane's compromise crosses into the other.
2. **Content-addressing with sign/encrypt-before-CID (no transport trust).** Both identify objects by hash, never by transport or arrival path. LCAP's `record_cid` is over the deterministic **signed plaintext** body (proof bytes excluded, §5.1); WS-S's CID is always over **ciphertext** (a plaintext private CID must never exist, §9.1). The formats differ deliberately (LCAP's own multihash layout vs IPLD CIDv1) and must never be conflated.
3. **P2P dependency isolation & code-split budget governance.** Both keep their heavy P2P/crypto dependencies out of the core: WS-R's WebRTC/Helia stack lives in `@licio/lcap-p2p` and WS-S's Helia/libp2p/MLS/HPKE/Argon2 stack in `packages/private-p2p` — both `workspace:*` (excluded from the `apps/web` `< 15` direct-production-dep budget) and loaded only from dynamically-imported, **code-split** route chunks so the **< 200 KB gz initial-bundle gate never regresses**. The native courier's `@capacitor/*` deps are native-shell-scoped (`apps/courier`). Every such dependency passes the Section 6.12.12 dependency-addition checklist (no install scripts, AGPL-compatible license, transitive count reviewed, SBOM updated).
4. **Doctrine gates extended to every new tree.** `check:no-applause` and `check:no-raw-egress` extend to `packages/lcap`, `@licio/lcap-p2p`, `apps/courier`, `apps/web/src/lcap`, `packages/private-p2p`, and `apps/web/src/private-p2p`. Each plane adds its own egress gate: WS-R's `check:lcap-schema-egress` (no IP/location/attention/multiaddr/radio identifier in any LCAP schema) and WS-S's seven `check:*p2p*` / `check:*private*` gates (no private content/CID/head/member-list/key on the server). No like/vote/karma/reaction or financial field appears in any schema of either plane.
5. **Identity-free abuse control (Section 19.1).** Neither plane reads a client network address. LCAP rate limiting and WS-S rendezvous/stub limits both key on a non-reversible account reference, matching the shipped posture.
6. **Room/visibility composition.** WS-Q's binary *server* visibility (`public | private`) and per-item visibility (`public | room_only`) are unchanged. LCAP's `private` visibility scope maps to WS-S `private_p2p` content and is carried **only as ciphertext** — it **never** enters the LCAP server room log. WS-S adds `private_p2p` as a third room class via the orthogonal `storage_mode` / `authority_model` / `directory_mode` axes; "private" unqualified is reserved for `private_p2p` (server-hosted restricted rooms are "members-only server rooms").
7. **Fail-closed, honest UI, and task sizing.** Both fail closed on unknown/unverified/undecryptable input; both forbid collapsing trust/liveness/limits into a single false "secure"/"verified"/"delivered" badge; both size every card as one reviewable, reversible deliverable (≤ 1–3 engineering days). Plane-specific conventions are listed under each Part.

**The single composition seam (the only cross-plane edge).** On the LCAP side, **WS-R.16.1** (the `EncryptedPayloadDescriptorV2` carrier) and **WS-R.11.5** (private-content-as-ciphertext replication); on the WS-S side, **WS-S.6.5** (offline CAR exchange + optional LCAP bundle). LCAP carries WS-S ciphertext blocks + opaque room hints and reuses the lane scheduler / liveness labelling; WS-S owns all key authority (MLS/HPKE) and never exposes plaintext, keys, op-heads, or real private-room ids to LCAP. Where the two disagree for private-room content, **`PRIVATE_SPEC` wins**.

## How this document is organized

**Part I (WS-R)** and **Part II (WS-S)** each carry their full plane-specific overview (touched-modules / integration-point tables, relationship notes, and conventions) followed by every atomic card. The **unified back-matter** at the end gives the one cross-plane dependency graph (both sub-graphs + the seam), the combined phase/wave plan, the merged milestone-gate table, and the combined definition of done. The original card IDs (`WS-R.0.1` … `WS-R.18.6`, `WS-S.0.1` … `WS-S.11.6`) are all preserved; nine bundled cards have since been **decomposed into smaller, independently-testable sub-cards** (e.g. `WS-R.9.2 → 9.2a/9.2b`, `WS-S.3.6 → 3.6a/3.6b/3.6c`), bringing the total to **171** — each card a single deliverable reviewable, testable, and reversible in ≤ 1–3 engineering days (§30.8).

---

# Part I — WS-R: Offline Content Availability (LCAP v0.2)

*Source spec: `docs/OFFLINE_SPEC.md`. The plane-specific overview, touched-modules table, relationship notes, and conventions follow; then the 104 WS-R cards (WS-R.0 foundations → WS-R.18 acceptance). The cross-plane back-matter is unified at the end of the document.*

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

**Description:** Implement `packages/lcap/src/pack/writer.ts` producing the §14.3 layout: magic `LCAPACK2\n`, LDC `PackHeaderV2`, LDC `PackTableV2` (object table **before** frames so a receiver can decide to import/skip/range-fetch), then `PackFrameV2`s, optional trailer. The writer streams (bounded memory) and is **parameterized by a caller-provided ordered object list** — the scheduler (WS-R.5.2c) produces that order at integration time (WS-R.15.1a), so the writer build-depends only on the schemas/codec, not the scheduler. It labels privacy (`privacy_label`) and lanes from the entries it is given.

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

**Dependencies:** WS-R.0.7, WS-R.1.4, WS-R.9.2b.

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

**Description:** Implement the consensus stage and the public `validate(record_cid)` that runs 8.2a→b→c and returns `(trust_state, missing_cids)`: (11) check known revocations (WS-R.1.4) → `revoked`; (12) check device-sequence/fork (WS-R.2.4) → `conflicting`; (13) check checkpoint inclusion if available (WS-R.9.3a) → toward `checkpointed`; (14) check checkpoint consistency if available (WS-R.9.3b) → `conflicting` on a fork; (15) fold all facts into the final state (incl. `stale_authorized` when the local revocation/checkpoint frontier is behind, and `witnessed` when a witness statement is present). `validate` is the **single entry point both client and server call** (one implementation), persisting to `trust_projection`.

**Acceptance criteria:**
- The final state is the lub of all discharged facts; revocation/fork/stale/witnessed are reflected exactly; nothing upgrades past missing evidence.
- Client and server import the same `validate` (a static check forbids a second copy); output is identical on shared fixtures.
- Each terminal routes to the precise status (`revoked`/`conflicting`/`checkpointed`/`stale_authorized`/`witnessed`).

**Testing:** Unit — steps 11-15 matrix; full-pipeline state lub; client≡server output on shared fixtures; missing-deps reporting.

**Dependencies:** WS-R.8.2b, WS-R.2.4, WS-R.9.3a, WS-R.9.3b, WS-R.1.4.

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
- The log feeds checkpoint scheduling (WS-R.9.2b) and display ordering (WS-R.2.3).

**Testing:** Gated integration (Postgres) — append ordering; idempotent re-append; topological constraint.

**Dependencies:** WS-R.12.2. (Append is a DB primitive the WS-R.12.1c commit stage calls after validation — the runtime ordering, not a build dependency.)

---

### WS-R.9.2a Merkle tree hashing (both algorithms) + tree vectors
**ID:** WS-R.9.2a | **Ref:** OFFLINE_SPEC §19.1.1

**Description:** Implement the pure §19.1.1 Merkle tree in `packages/lcap/src/checkpoint/merkle.ts`: `merkleRoot(leafCids: Uint8Array[], algorithm): Uint8Array` and `treeFromLeaves(...)` over RFC 6962/9162 domain-separated hashing — empty `= SHA-256("")`, leaf `= SHA-256(0x00 || leaf_payload)`, node `= SHA-256(0x01 || left || right)`, with the RFC 6962 §2.1 largest-power-of-two split for odd leaf counts. Support both `tree_algorithm` values via a single hashing strategy: `RFC9162_SHA256` (leaf payload = the 36-byte record `cid_bytes`; CT-tool compatible, RECOMMENDED) and `LCAP_MERKLE_V2` (leaf payload = `domain_separator_hash || cid_bytes`, binding the tree to one network so a leaf from network A cannot verify against network B's checkpoint). No record/proof I/O — this is leaf-bytes-in, root-out, plus the internal node array used by inclusion/consistency (WS-R.9.3a/b). Commit `test-vectors/merkle.json` (leaf set → root, for both algorithms, including empty/single/odd-count trees).

**Acceptance criteria:**
- Leaf/node hashing matches the committed vectors for both algorithms; empty, single-leaf, two-leaf, and odd-leaf (e.g. 5-leaf) trees produce the documented roots.
- `RFC9162_SHA256` output is byte-identical to a reference CT (RFC 9162) implementation for the same leaf set.
- `LCAP_MERKLE_V2` binds the domain separator into every leaf; the same `cid_bytes` under two different `network_id`s yields different roots.

**Testing:** Unit — tree-hash vectors (both algorithms); empty/single/odd-count split; RFC-9162 cross-check; network-binding differential.

**Dependencies:** WS-R.0.3, WS-R.0.1.

---

### WS-R.9.2b `room_checkpoint` record + authority proof
**ID:** WS-R.9.2b | **Ref:** OFFLINE_SPEC §19.1.1, §19.2

**Description:** Implement the signed `room_checkpoint` record in `packages/lcap/src/checkpoint/record.ts`: a closed-schema body (`room_id` or `room_id_hash`, `tree_algorithm`, `tree_size`, `merkle_root`, `policy_epoch`, `revocation_epoch`, `prev_checkpoint_cid?`, `signer_key_id`, validity window) plus its `authority_signature` proof built via WS-R.0.6a and verified via WS-R.0.6b. The `merkle_root` is computed by WS-R.9.2a over the WS-R.9.1 room-log slice `[0, tree_size)`. The `tree_algorithm` named in the body is the ONLY algorithm a verifier may use against this checkpoint (no per-proof override), so a checkpoint and its proofs cannot disagree on the hashing rule.

**Acceptance criteria:**
- A checkpoint is untrusted without a valid authority proof; `tree_algorithm`/`tree_size`/`merkle_root`/`policy_epoch`/`revocation_epoch`/`prev_checkpoint_cid` are all inside the signed body.
- A checkpoint whose `merkle_root` does not equal `merkleRoot(log[0:tree_size], tree_algorithm)` fails verification; a proof computed under a different algorithm than the checkpoint names is rejected at WS-R.9.3a/b.
- `prev_checkpoint_cid` chains successive checkpoints for the consistency check (WS-R.9.3b).

**Testing:** Unit — checkpoint build/verify; missing/forged-authority-proof rejection; root-mismatch rejection; chain linkage.

**Dependencies:** WS-R.9.2a, WS-R.0.6a, WS-R.0.6b, WS-R.9.1.

---

### WS-R.9.3a Inclusion proof record + RFC 9162 verifier
**ID:** WS-R.9.3a | **Ref:** OFFLINE_SPEC §19.1.2, §19.3

**Description:** Implement the `inclusion_proof` record and the RFC 9162 §2.1.3 verifier in `packages/lcap/src/checkpoint/inclusion.ts`: `verifyInclusion({ leaf_index, tree_size, proof_hashes, leaf_cid, checkpoint })` recomputes a candidate root from `(leaf_index, tree_size, proof_hashes, leaf_cid)` using the checkpoint's named `tree_algorithm` (WS-R.9.2a hashing) and requires byte equality with the checkpoint's `merkle_root`. Out-of-range `leaf_index ≥ tree_size`, a wrong-length `proof_hashes` for the `(index, size)` pair, or a non-matching root each fail with a typed status. The proof record is closed-schema and carries the `checkpoint_cid` it is proven against.

**Acceptance criteria:**
- A valid inclusion proof verifies a record's membership against its checkpoint; a tampered proof hash, wrong `leaf_index`, wrong `leaf_cid`, or wrong `tree_size` fails.
- The recomputed-root path uses the checkpoint's `tree_algorithm` only; verification is byte-compatible with RFC 9162 §2.1.3 for `RFC9162_SHA256` (cross-checked against a reference vector).
- `test-vectors/inclusion.json` (tree + index → proof → root) is committed and replayed.

**Testing:** Unit — happy path + the four tamper cases; out-of-range index; RFC-9162 vector replay.

**Dependencies:** WS-R.9.2a, WS-R.9.2b.

---

### WS-R.9.3b Consistency proof record + verifier + fork-evidence trigger
**ID:** WS-R.9.3b | **Ref:** OFFLINE_SPEC §19.1.2, §19.4

**Description:** Implement the `consistency_proof` record and the RFC 9162 §2.1.4 verifier in `packages/lcap/src/checkpoint/consistency.ts`: `verifyConsistency({ first_size, second_size, proof_hashes, first_root, second_root, tree_algorithm })` requires that the second (larger) tree provably **extends** the first with no leaf rewritten, reordered, or removed. The two roots come from two checkpoints the same authority signed (linked by `prev_checkpoint_cid`, WS-R.9.2b). A failed consistency check between two same-authority checkpoints is equivocation: it returns a typed `consistency_failed` result carrying both checkpoints + their authority proofs, which WS-R.9.4 packages as C0/P0 `fork_evidence`. This card owns the verifier + the failure signal; WS-R.9.4 owns the evidence object and gossip.

**Acceptance criteria:**
- A valid consistency proof links successive checkpoints of the same room/authority; a rewritten-history or shrunk-tree pair fails.
- A consistency failure emits the typed `consistency_failed` signal with both checkpoints' bodies + proofs (consumed by WS-R.9.4), never a silent pass.
- Verification is byte-compatible with RFC 9162 §2.1.4 for `RFC9162_SHA256`; `test-vectors/consistency.json` is committed and replayed.

**Testing:** Unit — happy path + rewritten/shrunk tamper; `consistency_failed` signal shape; RFC-9162 vector replay.

**Dependencies:** WS-R.9.3a, WS-R.9.2b.

---

### WS-R.9.4 Witness statements + checkpoint-fork evidence
**ID:** WS-R.9.4 | **Ref:** OFFLINE_SPEC §19.5, §19.6

**Description:** Implement `witness_statement` (a signed observation of a checkpoint by an independent witness — increases confidence the authority is not silently equivocating; witnesses create no canonical state) and the checkpoint-fork rule: two signed checkpoints for the same room and `tree_size` with different roots is fork evidence — stored as C0/P0 `fork_evidence`, gossiped, and surfaced as a severe consistency warning.

**Acceptance criteria:**
- A witness statement verifies and raises a record's state toward `witnessed`; it never substitutes for inclusion/consistency.
- Two-roots-same-size is detected and produces gossiped C0 fork evidence + a severe UI warning (WS-R.17).
- Fork evidence carries both checkpoints, their authority proofs, and observed context.

**Testing:** Unit — witness verify; checkpoint-fork detection; evidence assembly + P0 classification.

**Dependencies:** WS-R.9.2b, WS-R.9.3b (consumes the `consistency_failed` signal), WS-R.2.4.

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

**Dependencies:** WS-R.11.3b.

---

## WS-R.11 Replication policy and local storage

### WS-R.11.1 Priority/pinning classes + eviction order
**ID:** WS-R.11.1 | **Ref:** OFFLINE_SPEC §21.1, §21.2

**Description:** Implement the priority classes (P0–P4) and pinning classes (`hard_pin`/`user_pin`/`policy_pin`/`cache_pin`/`courier_pin`/`relay_pin`) and the §21.2 eviction order (P4 ambient → old M3 → old E2 not user-pinned → old P1 from unsubscribed rooms → quarantine overflow → never hard_pin). GC respects this order strictly.

**Acceptance criteria:**
- Eviction follows the documented order; `hard_pin` is never evicted by normal GC.
- A record's pin class is recorded in `gc_index`; user pins outrank ambient cache.

**Testing:** Unit — eviction-order property over a mixed store; hard-pin invariance.

**Dependencies:** WS-R.11.3a.

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

### WS-R.11.3a `lcap_v2` IndexedDB schema + indexes + versioned migration
**ID:** WS-R.11.3a | **Ref:** OFFLINE_SPEC §23.1

**Description:** Implement the dedicated `lcap_v2` IndexedDB database in `apps/web/src/lcap/db.ts` (a **separate** database from the existing `licio` DB, `apps/web/src/offline/db.ts`, so LCAP versioning/GC/quarantine evolve without migrating the WS-C stores) with the §23.1 object stores — `records`, `proofs`, `blocks`, `chunks`, `manifests`, `outbox`, `quarantine`, `trust_projection`, `liveness`, `frontiers`, `receipts`, `gc_index` — their key paths, and the secondary indexes for room / priority / trust-state / pin-class lookups. Provide the versioned `onupgradeneeded` migration scaffold (open → create stores/indexes on version bump) following the WS-C migration pattern. This card owns the schema shape only; the §23.2 access-pattern/durability layer is WS-R.11.3b.

**Acceptance criteria:**
- `lcap_v2` is created with all twelve stores + their indexes and **never collides** with the `licio` database name/version; a `DB_NAME = 'lcap_v2'` constant mirrors the `licio` pattern.
- Each store's key path + secondary indexes (room, priority, state, pin-class) exist and are queryable; a versioned upgrade path adds a store/index without data loss.
- A static check asserts `apps/web/src/lcap` does not open or migrate the `licio` database.

**Testing:** Unit (`fake-indexeddb`) — store/index creation; versioned upgrade; name-isolation from `licio`.

**Dependencies:** WS-R.0.1.

---

### WS-R.11.3b §23.2 IndexedDB durability layer (streaming, blob separation, transactional commit, quota retry)
**ID:** WS-R.11.3b | **Ref:** OFFLINE_SPEC §23.2

**Description:** Implement the §23.2 access-pattern + durability layer over the WS-R.11.3a schema: **no `getAll`** on large stores (cursor iteration only); cursor/streaming reads+writes for bundle import/export (bounded memory); large blocks stored as `Blob`/chunk records with **metadata↔blob separation** (descriptor row + separate blob row); **transactional** verification-state commit (a record's body + proof + trust-state advance commit atomically so a crash never leaves a half-verified record); **capped transaction size** for old phones (split large imports into bounded transactions); and **transient-quota retry** (on `QuotaExceededError`, shed P4 ambient cache per WS-R.11.1 and retry, surfacing pressure honestly). All LCAP store access funnels through this layer.

**Acceptance criteria:**
- No code path calls `getAll` on `records`/`blocks`/`chunks`; import/export streams via cursors with bounded memory; large blocks store as separated blob+metadata rows.
- Verification-state commit is transactional (body+proof+state atomic); a simulated mid-commit crash leaves no half-verified record.
- Old-phone transaction caps hold; a transient quota error sheds ambient cache and retries rather than failing the write.

**Testing:** Unit (`fake-indexeddb`) — cursor-only streaming; blob/metadata separation; transactional-commit atomicity; capped-transaction split. Gated — quota-retry path.

**Dependencies:** WS-R.11.3a, WS-R.11.1.

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

**Description:** Implement the commit stage: for accept-eligible records, idempotently accept by `record_cid` + semantic uniqueness (WS-R.12.3), **append to the room log** (WS-R.9.1) under a transaction, mark `validation_state = server_accepted`, and **trigger the checkpoint schedule** (WS-R.9.2b runs on the maintenance tick). Emit signed/authenticated receipts (WS-R.10.2) for stored/accepted/rejected/quarantined_missing_dependency/checkpointed, and return the per-object `ObjectStatusV2[]` plus `WantRequestV2[]` for the precise missing dependencies. The MUST-NOT-emit-before-validation rule (§24.2) holds because acceptance is the only path that writes the room log.

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

**Dependencies:** WS-R.12.1c, WS-R.6.2, WS-R.9.3a, WS-R.9.3b.

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

### WS-R.14.1a Centralized §27.1 resource caps + shared chokepoint
**ID:** WS-R.14.1a | **Ref:** OFFLINE_SPEC §27.1

**Description:** Centralize the §27.1 resource caps in `packages/lcap/src/limits/caps.ts` as one frozen config object — max pack / header / table / frame / uncompressed sizes, max compression (expansion) ratio, max manifest entries, max dependency depth, max missing deps per object, max proofs per record, max signature failures per import, max quarantine bytes, max CPU time per import batch — and a single enforcement helper every parser path (WS-R.4.2 reader, WS-R.3.4 decompressor, WS-R.12.1a server parse) consumes. A breach aborts with `rejected_resource_limit` carrying the violated cap name. Caps are profile-tunable (old-phone vs server) but never disable-able.

**Acceptance criteria:**
- Every listed cap is enforced at the single shared chokepoint; a breach aborts with `rejected_resource_limit` naming the cap.
- No parser path hard-codes a limit outside the shared config; a static check asserts the reader/decompressor/server-parse all import the shared caps.
- Caps are profile-tunable but cannot be set to unlimited.

**Testing:** Unit — each cap boundary (at/over); shared-config-only assertion; profile tuning bounds.

**Dependencies:** WS-R.4.2.

---

### WS-R.14.1b §27.2 malicious-dependency-graph detectors
**ID:** WS-R.14.1b | **Ref:** OFFLINE_SPEC §27.2

**Description:** Implement the §27.2 malicious-graph detectors in `packages/lcap/src/limits/graph-guard.ts`, run over the declared dependency DAG **before** any closure expansion: cycle detection, excessive fan-out, excessive depth, duplicate dependencies, **private metadata in a public export**, and unknown critical fields. Each detector returns a typed rejection (`rejected_resource_limit` / `rejected_bad_schema` / a privacy rejection) consumed by the reader (WS-R.4.2) and the server parse (WS-R.12.1a). Detection runs within the WS-R.14.1a CPU/time cap so the guard itself cannot be a DoS vector.

**Acceptance criteria:**
- Cyclic, over-fan-out, over-deep, and duplicate-dep graphs are detected and rejected **before** expansion; private metadata in a public export is detected and blocked.
- An unknown critical field fails closed (`rejected_bad_schema`); each detector returns its exact status code.
- The guard executes within the §27.1 CPU/time cap (it cannot be turned into a DoS).

**Testing:** Unit — each detector (cycle/fan-out/depth/dup/private-metadata/unknown-critical) with its status. Security — dependency-bomb corpus (WS-R.18.4).

**Dependencies:** WS-R.14.1a.

---

### WS-R.14.2 Interest/bundle privacy + stealth mode
**ID:** WS-R.14.2 | **Ref:** OFFLINE_SPEC §26.1, §26.2, §26.3

**Description:** Implement the export privacy warning (rooms included, in-room/private metadata present, encrypted payloads present, approximate size, media included, identities/device ids included, that recipients may copy onward) and stealth mode (disable automatic local discovery + courier advertising + background relay sync; generic filenames; C0-only unless user-initiated; confirm before export; minimal cache). Interest descriptors to unknown peers reveal only public/opaque hints (WS-R.6.3).

**Acceptance criteria:**
- Export shows the full §26.2 disclosure before producing a bundle.
- Stealth mode disables discovery/advertising/background sync and uses generic filenames.
- No private-room membership/contact/social-graph leaks to unknown peers or relays.

**Testing:** Unit — disclosure completeness; stealth-mode toggles. E2E — export-warning flow (WS-R.15.1a/15.1b import/export E2E).

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

### WS-R.15.1a Manual `.licio-bundle` export flow
**ID:** WS-R.15.1a | **Ref:** OFFLINE_SPEC §22.2

**Description:** Implement the REQUIRED bundle **export** transport in `apps/web/src/lcap/bundleExport.ts`: choose scope → show the WS-R.14.2 privacy warning → size estimate → display included lanes/priorities → stream the pack via the WS-R.4.1 writer → save/share the file (platform File System Access / download APIs, no npm dependency) → record `exported` liveness (WS-R.10.1). High-risk exports offer a generic, room/topic-free filename (WS-R.4.4). The export is parameterized by the scheduler-emitted object order so C0/control material leads.

**Acceptance criteria:**
- Export shows the privacy warning + size estimate + included lanes **before** producing the file, and records `exported` liveness afterward.
- The pack streams with bounded memory (WS-R.4.1) in scheduler order; a high-risk export offers a generic filename.
- No npm dependency (platform file APIs only).

**Testing:** E2E (Playwright + axe) — export happy path + privacy-warning-before-file; a11y on each state; generic-filename option.

**Dependencies:** WS-R.4.1, WS-R.14.2, WS-R.10.1.

---

### WS-R.15.1b Manual `.licio-bundle` import flow
**ID:** WS-R.15.1b | **Ref:** OFFLINE_SPEC §22.2, §14.7

**Description:** Implement the bundle **import** transport in `apps/web/src/lcap/bundleImport.ts`: select file → check size/magic → parse header/table under the WS-R.14.1a caps → show a **summary before render** → stream frames through the WS-R.4.2 reader (verify CIDs/schemas/proofs) → quarantine missing-dependency records (WS-R.4.3) → commit verified/provisional objects → update liveness. **Nothing renders before trust projection** (WS-R.8.3). A malformed/oversized/truncated file fails cleanly with a typed status.

**Acceptance criteria:**
- Import shows a summary **before** rendering, verifies every frame, quarantines missing deps, and renders nothing before trust projection.
- A malformed/oversized/truncated file is rejected/quarantined cleanly (no crash, no partial trusted render).
- Round-trip: a bundle exported by WS-R.15.1a imports here with no semantic change (proven in WS-R.18.5).

**Testing:** E2E (Playwright + axe) — import happy path + malformed-file rejection + summary-before-render; a11y on each state.

**Dependencies:** WS-R.4.2, WS-R.4.3, WS-R.8.3, WS-R.14.1a.

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

**Dependencies:** WS-R.15.1a, WS-R.15.1b, WS-R.11.4.

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

**Status:** SHIPPED + driven end-to-end: `NearbyCourierPlugin.java` is compiled into the debug APK and `apps/web/src/lcap/transports/courier-controller.ts` (`CourierController`) drives it to actual byte exchange (off-by-default, public-only, anchor-last); netsim-verified (WS-R.15.4f).

**Description:** Implement a typed Capacitor plugin bridging Android **Nearby Connections** (advertise / discover / request-connection / accept / send-payload / receive) to TS as an `LcapTransport` byte channel; stream packs as bounded chunks (transport-profile chunk sizes, §13.2) with backpressure; verify each reassembled block CID on receipt. The JS↔native boundary is strict-zod-validated and bounded by the §27.1 resource caps.

**Acceptance criteria:**
- The plugin advertises/discovers, establishes a Nearby channel, and streams packs as size-profiled chunks that reassemble with per-chunk **and** block-CID verification.
- The JS↔native boundary is zod-validated and cap-bounded; a malformed native payload fails closed (`rejected_*`/`quarantined_*`), never crashes the shell.

**Testing:** Native instrumentation/contract test (two emulators exchange a pack); JS-boundary zod accept/reject matrix; chunk/reassembly verification.

**Dependencies:** WS-R.15.4a, WS-R.15.4b, WS-R.3.2.

---

### WS-R.15.4d Wi-Fi Direct / local hotspot / Bluetooth / USB channels
**ID:** WS-R.15.4d | **Ref:** OFFLINE_SPEC §22.5

**Status:** SHIPPED (three additional plugins on the proven Nearby pattern, same `CourierTransport` adapter): `WifiDirectCourierPlugin.java` (Wi-Fi Direct — group formation is gated to real radios: the framework works on the emulator (`discoverPeers` SUCCESS) but netsim bridges only Bluetooth, not Wi-Fi, so two stock emulators never discover each other; only the post-group length-prefixed socket path — identical to RFCOMM — is netsim-equivalent), `BluetoothCourierPlugin.java` (Classic RFCOMM + a now-IMPLEMENTED duplex BLE-GATT fallback — a write+notify characteristic + a length-prefixed `FrameAssembler`, version-guarded for minSdk 23; BOTH netsim-verified by `BluetoothRfcommRadioTest` + `BleGattRadioTest`), `UsbCourierPlugin.java` (USB accessory mode — physical-OTG-only; there is no emulated USB bus), all compiled into the debug APK as dumb byte pipes (frames re-verified against CIDs/COSE on the TS side, public-only, 64 MiB frame bound).  ALL FOUR plugins are now thin Capacitor HUMBLE OBJECTS over per-radio drivers (`Nearby`/`Bluetooth`/`WifiDirect`/`Usb`CourierRadio`/`WifiDirectRadio`) on one shared `CourierRadio` contract, over the PURE `CourierFraming` (length-prefix framing + `FrameAssembler` + blocking-stream `readFramedStream` + serialize-on-ack chunked send); GMS Nearby is isolated behind a `NearbyConnections` seam.  So the courier's LOGIC is tested by `pnpm --filter courier test:unit` (a CI gate) with NO emulator / radio / root — **79 JVM tests**: Layer-1 pure (`CourierFramingTest` framing; `BleSendPumpTest` the BLE send state machine; `CourierStreamLinkTest` the shared blocking data-path over pipes) + Layer-2 the `*RadioTest`s (BLE GATT contract + BOTH receive directions — peripheral write-request AND central `onCharacteristicChanged` notify reassembly, incl. the pre-33 deprecated overload via `@Config(sdk=31)`; the Nearby fake-seam orchestration; send-routing/idempotent-stop) — and the real-radio `radio-e2e.sh` matrix is the optional Layer-3 hardware-confidence layer.  A follow-up design audit eliminated the two remaining smells: (1) BLE SEND is now **callback-driven** (`BleSendPump` — enqueue writes the first chunk, the write-complete callback drives the next, a scheduled timeout fails a stalled write, disconnect fails all), replacing the async-into-blocking thread + `BlockingQueue` + 30s poll, so the entire send state machine is pure + deterministically tested (no cross-thread rendezvous, no leaked thread); (2) the three blocking-stream transports (RFCOMM / Wi-Fi Direct / USB) share ONE pipe-tested data-path, `CourierStreamLink`, so the Wi-Fi `dataPort`-ForTest seam was **removed** (the only test-only production seam).  Earlier hardening stands: `FrameAssembler` is amortized **O(n)** (no per-chunk full-buffer copy), `stop()` closes live sockets, and `serverSocket`/`descriptor` are `volatile`.  (The BLE CLIENT send is covered end-to-end — `bleClientSendDrivesAMultiChunkFrameToCompletion` injects a discoverable service into the shadow gatt, whose `writeCharacteristic` acks SUCCESS, so a 2000-byte multi-chunk send self-drives through the radio's real `onCharacteristicWrite → pump.onAck` wiring; the CENTRAL notify is covered by its fail-closed test + the central-receive reassembly (only a SUCCESSFUL notify stays real-radio-only); and the RFCOMM data path is now driven over a REAL shadow `BluetoothSocket` via `ShadowBluetoothServerSocket.deviceConnected` + the stream feeder/sink.)  A SECOND audit then hardened the redesign: BLE ack-timeout `arm()` never resurrects a stopped scheduler (a `stop()`/disconnect race that could throw `RejectedExecutionException` out of a binder callback), USB `stop()` closes the READ stream (not just the accessory descriptor) so a parked reader unblocks + fires `onDisconnected`, `CourierStreamLink` removes its outbound entry BY VALUE (a same-endpoint reconnect can't clobber the newer link), and `BleSendPump` null-checks its inputs — each with a regression test (`stopClosesTheReadStreamToUnblock…`, `aReconnectingEndpointKeepsItsNewerOutboundEntry`).  The two residuals were then CLOSED: the BLE scheduler→timeout glue is a named, unit-tested `ScheduledAckTimeout` (a real scheduler + a short delay covers arm-fires / cancel / re-arm-cancels-prior / shutdown-tolerated — no 30s wait, no seam), and the unbounded thread-per-send became a BOUNDED daemon send executor with caller-runs backpressure (`CourierStreamLink.newSendExecutor`, ≤8 threads, self-reaping) shared by RFCOMM/Wi-Fi/USB through `CourierStreamLink.send`.  A FINAL audit closed two more: (a) a stale-timeout race — chunk N's 30s timeout, already RUNNING when its ack re-armed for chunk N+1 (`cancel()` cannot stop a running task), could spuriously fail the advanced send — is fixed by a per-arm EPOCH echoed to `BleSendPump.onTimeout(epoch)` and checked under the pump monitor (a stale epoch is a no-op); (b) `CourierStreamLink.send` now guards `isShutdown()` → `onError` (the executor's `CallerRunsPolicy` SILENTLY DISCARDS after shutdown, leaking the `SendResult`/PluginCall if a `shutdown()` were ever added) and the dead `RejectedExecutionException` catch was removed — both with a regression test proven to fail without the fix (`aStaleTimeoutDoesNotFailAnAdvancedSend`, `sendOnAShutDownExecutorReportsFailureNotASilentDrop`).  The six pre-33 BLE deprecations (the value-carrying overloads are API-33+; minSdk stays 23 to maximize device reach for the offline plane) are isolated in three minimal `*Legacy` compat shims — NOT broadly suppressed — leaving every real method deprecation-checked (compileSdk/targetSdk are 35).  The TS `NativeChannelMedium` is unaffected; the dead `endpointFound`/`connectionInitiated`/`endpointLost` Nearby events were dropped.

**Description:** Extend the courier with the remaining §22.5 channels behind the *same* `CourierTransport` adapter: Wi-Fi Direct + local hotspot (higher-throughput LAN ferry), Bluetooth file transfer (low-bandwidth C0/T1 ferry), and USB import/export (reuses the WS-R.15.1a/15.1b `.licio-bundle` path — **no new format**). Each channel selects chunk size and lane budget from its transport profile (§13.2/§15) so Bluetooth stays C0-first while LAN uses larger chunks.

**Acceptance criteria:**
- Each channel moves the same packs through the same adapter; chunk size + lane budget follow the channel's transport profile (LAN larger; Bluetooth small + C0-first).
- USB transfer is exactly a `.licio-bundle` import/export (no courier-specific format or trust path).

**Testing:** Per-channel contract test; transport-profile-selection unit; USB-equals-bundle-path assertion.

**Dependencies:** WS-R.15.4c.

---

### WS-R.15.4e Courier controls, private-content exclusion, and metadata-privacy disclosure
**ID:** WS-R.15.4e | **Ref:** OFFLINE_SPEC §22.5, §26.2, §26.3, §33.5

**Status:** SHIPPED: the §22.5 controls + the mandatory radio-metadata disclosure ack gate live in `apps/web/src/lcap/transports/courier-controls-state.ts` (radios off by default, conservative fallback on an invalid persisted slice) and the `CourierControls` UI (the advertise/discover toggles disabled until the disclosure is acknowledged; revoking forces the radios off); `decideCourierStart` force-offs in Stealth/Emergency; carriage is public-only.

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

**Status:** SHIPPED + RE-VERIFIED on emulated radios with a MULTI-MEDIUM, MULTI-SCENARIO matrix: two headless Android emulators sharing the netsim virtual radio bus (RootCanal BLE/Bluetooth) run `apps/courier/scripts/radio-e2e.sh` over SIX coordinated two-device scenarios, all green — **Nearby Connections** (`NearbyConnectionsRadioTest`): basic single-frame, a 512 KiB pack streamed as 64 ordered chunks + reassembled BYTE-EXACT (the §13.2 chunked-pack path), bidirectional duplex, and the disconnect-lifecycle event; **Bluetooth LE GATT** (`BleGattRadioTest`): advertise + GATT server + a central's serialized chunked writes, integrity-asserted; and **Bluetooth Classic RFCOMM** (`BluetoothRfcommRadioTest`): an insecure (no-pairing) length-prefixed 64 KiB frame, the client dialing A's address directly. The §22.5 **BLE-GATT fallback** the comment promised is now REAL in `BluetoothCourierPlugin` (a duplex write+notify characteristic + a length-prefixed `FrameAssembler`, version-guarded for minSdk 23) and is the `BleGattRadioTest` path. **Wi-Fi Direct group formation can't be exercised between two STOCK AVD emulators** — empirically the framework works (`discoverPeers` returns SUCCESS, a `p2p-dev-wlan0` interface exists), but netsim bridges only Bluetooth (RootCanal), NOT Wi-Fi, so the two emulators never discover each other (no shared Wi-Fi medium carries the P2P probe frames — which is exactly why the Bluetooth-based legs cross netsim and Wi-Fi Direct does not).  So `WifiDirectRadioTest` is gated to real radios (or a Cuttlefish/wmediumd shared-Wi-Fi medium) via `-e includeWifiDirect 1` and excluded from the default matrix (opt in with `RADIO_E2E_INCLUDE_WIFI_DIRECT=1`); its post-group length-prefixed socket path is byte-identical to the proven RFCOMM leg. The script is now self-validating (it preflights that each AVD's system image is installed) and matrix-driven. Field confirmation on PHYSICAL phones (Wi-Fi Direct group formation; USB-OTG, which has no emulated bus) is the only remaining hardware-gated step.

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

### WS-R.15.6a WebRTC data-channel P2P transport + server-blind signaling
**ID:** WS-R.15.6a | **Ref:** OFFLINE_SPEC §22.6, §16.3, §18.4, §19.1, §26.4

**Status:** SHIPPED + now driven LIVE: `syncRoomOverP2p` (`apps/web/src/lcap/transports/sync-over-p2p.ts`) is the FIRST runtime consumer of the `WebrtcTransport` — it derives a PUBLIC signaling key by HKDF over the public `roomIdHash` (`signal-key.ts`; the WS-S engine never imports it), establishes a live channel over the server-blind rendezvous (`connectLcapWebrtc`, dynamic-import only), and runs ONE §16 exchange through `offlineExchange` (HTTPS anchor still forced LAST). `@licio/lcap-p2p`'s `webrtc/fragment.ts` carries ≤ 16 KiB SCTP-safe fragments with fail-closed reassembly + the 16 MiB §27 bound.

**Description:** In the code-split `@licio/lcap-p2p` package, implement a WebRTC `RTCDataChannel` `LcapTransport` for browser↔browser pack exchange. **Signaling rides the existing Licio HTTPS API** via a session-bound `POST /api/lcap/v2/p2p/signal` rendezvous that routes an **end-to-end-encrypted, opaque signaling blob** between the two members — the server **never parses SDP/ICE, observes no peer IP, and logs only the opaque ciphertext** (mirroring the WS-S.6.2 encrypted-signaling pattern and preserving the §19.1 "the data plane reads no client network address" doctrine; ICE candidates / peer IPs are a §26.4 live-connection property of the direct browser-to-browser channel only, never of the server). Public STUN provides **client-side** NAT discovery. It reuses the `LcapTransport` seam (WS-R.15.4b), the scheduler order, and `validate`; it is **off by default**. The WebRTC + (15.7) Helia deps live behind the `@licio/lcap-p2p` workspace boundary and a separately code-split `apps/web/src/lcap/transports/` chunk so the web `<15` budget and the < 200 KB initial-bundle gate both hold.

**Acceptance criteria:**
- The `/api/lcap/v2/p2p/signal` rendezvous routes only **opaque, E2E-encrypted** signaling blobs: a static + runtime check proves the server never parses SDP/ICE and never reads/logs a peer IP (§19.1 parity with the rest of the data plane); ICE candidates appear only at the live datachannel between the two browsers.
- Two authenticated browsers establish an `RTCDataChannel` via the E2E-encrypted signaling rendezvous + STUN and exchange a scheduler-ordered pack; received frames go through the same reader/validator (source-independence holds).
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

**Description:** In `@licio/lcap-p2p`, implement a Helia / js-libp2p bridge that publishes and fetches **public blocks only**, loaded **only** from the separately code-split transports chunk so the initial-bundle gate holds. Because the LCAP `block_cid` is a custom §9 layout (not an IPFS CID), the bridge announces/requests over bitswap using the fixed **verification-preserving mapping** `ipfs_cid = CIDv1(raw 0x55, sha2-256 multihash)` over the **same `sha2-256` digest** the `block_cid` already embeds (§9.2), then recomputes and verifies the LCAP `block_cid` over every fetched block **before any use** — so DHT interop never weakens LCAP hash verification (no transport trust). The bridge stores/serves nothing private/in-room/ciphertext. Off by default.

**Acceptance criteria:**
- The bridge announces/fetches via the `CIDv1(raw, sha2-256) ⇄ block_cid` mapping (shared digest); a fetched block is re-verified against its LCAP `block_cid` before use (no transport trust); only `public`-visibility blocks are selectable.
- Helia/js-libp2p is confined to `@licio/lcap-p2p` (workspace-excluded) and the separately code-split chunk; the < 200 KB initial-bundle and `apps/web` `<15` budgets hold; the dependency-addition checklist (no install scripts, license, transitive count, SBOM) passes.

**Testing:** Gated/E2E — publish/fetch a public block by CID + CID-verify; public-only selection; bundle-size + code-split + budget assertions.

**Dependencies:** WS-R.15.6a, WS-R.3.1, WS-R.0.3.

---

### WS-R.15.7b IPFS publish review gate + public-only structural enforcement
**ID:** WS-R.15.7b | **Ref:** OFFLINE_SPEC §22.7, §37.2, §21.4, §26.4

**Status:** SHIPPED — the §22.7 review gate, the audit, the authorization, and the real provenance producer are all live (Gate-19, full closure). Defense-in-depth at PUBLISH and republish, in order: (1) `assertPublicGatewayEligible`/`decideBlockPublish` (§37.2 public-only); (2) the **REQUIRED §22.7 privacy/moderation/abuse-review gate** — `apps/api/src/lcap/review-gate.ts` (`assertPublishReviewApproved` over `BlockPublishReviewStore` / `lcap_block_publish_review`, migration `0049`): a block reaches the public DHT only if EVERY source content entity has a recorded `approved` review (an unreviewed / pending / rejected / source-less candidate is refused `review_required`; an unreadable review store fails closed); a steward records the affirmative decision through `POST /api/lcap/v2/public-bridge/review`; (3) `takedown-oracle.ts` (`DrizzleTakedownOracle`, fail-closed — a thrown query is a halt) re-checks the live status via the single `takedownInForce` rule. The two `POST /api/lcap/v2/public-bridge/{publish,republish}` routes (and `review`) are **STEWARD-AUTHORIZED** — `authMiddleware()` + a steward-role + active-MFA gate (finding #39). The publish path records the `block_cid → (target_type,target_id)` provenance **UNCONDITIONALLY** from a now-mandatory `content_targets` (finding #38), so the takedown halt cannot be bypassed by omission. **Every (re)publish decision — pinned OR refused — writes ONE append-only audit row** (`publish-audit.ts` / `lcap_publish_audit`, migration `0049`, append-only trigger; actor, block, target, review verdict, takedown verdict, outcome) so the gate decision is durably, queryably audited (finding #37). `@licio/lcap-p2p` is an `apps/api` dep (the DB binding it cannot import itself).

**Description:** Implement the **required** privacy/moderation/abuse-review gate that must pass before any block is published to the public DHT, plus structural public-only enforcement: a block is publishable only if its source record is `public` visibility (never `in_room`/`private`/ciphertext, never a private-room hint), confirmed against the WS-Q visibility model and WS-J takedown state. Published-block provenance is auditable, and a WS-J takedown retracts further republication.

**Acceptance criteria:**
- No block reaches the public DHT without passing the review gate; only `public`-visibility blocks qualify (in_room/private/ciphertext structurally excluded).
- A WS-J takedown halts further republication of the affected block; the gate decision is audited.

**Testing:** Unit — public-only enforcement matrix (each visibility/ciphertext case); the §22.7 review-gate matrix (unreviewed/pending/rejected/source-less refuse, every-target-approved allows, unreadable-store fail-closed); takedown-halts-republish; the route is steward-authorized (401 anonymous / 403 non-steward), records mandatory provenance, and AUDITS every decision; a steward records a review then the same block publishes. Gated PG (`takedown-oracle-pg.test.ts`, migration `0049`) — the Drizzle review store upsert + gate, and the append-only publish-audit (UPDATE/DELETE rejected by the trigger; TRUNCATE-reset).

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

**Status:** SHIPPED: `apps/web/src/lcap/cross-plane-bridge.ts` (`exportPrivateEnvelopesToBundle`/`importBundleToPrivateEnvelopes`) carries a WS-S `PrivateEncryptedEnvelope` inside an LCAP `.licio-bundle` as an opaque `encrypted_payload` block whose CID is over the CIPHERTEXT (§28.1); the `MLS-derived-AEAD` suite makes the §28.2 schema forbid any plaintext hint (§10.6), the only hints carried are already-public fields. LCAP re-hashes the CID + re-parses through the private-p2p envelope schema and NEVER decrypts (§8.3 — the container confers no trust; a stale-epoch envelope round-trips opaquely and is quarantined later by the engine).

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
- The corpus is the normative pin for determinism (referenced by WS-R.0.2c/0.3/0.6a/0.6b and WS-R.9.2a/9.2b/9.3a/9.3b).

**Testing:** Unit — vector replay across the codec/CID/COSE/Merkle modules.

**Dependencies:** WS-R.0.6b, WS-R.9.3a, WS-R.9.3b.

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

**Dependencies:** WS-R.14.1a, WS-R.14.1b, WS-R.0.8, WS-R.4.2.

---

### WS-R.18.5 Interoperability tests (browser ↔ Node)
**ID:** WS-R.18.5 | **Ref:** OFFLINE_SPEC §32.5

**Description:** Implement §32.5 interop: a record signed in the browser verifies in Node and vice versa; a bundle exported from one browser profile imports into another without semantic change. Runs in CI across the WebCrypto (browser/Playwright) and Node runtimes against the shared vector corpus.

**Acceptance criteria:**
- Cross-runtime sign/verify and bundle import/export round-trips pass.
- The shared corpus is the single source of truth for both runtimes.

**Testing:** Gated cross-runtime suite (Node unit + Playwright) over the WS-R.18.1 corpus.

**Dependencies:** WS-R.18.1, WS-R.15.1a, WS-R.15.1b.

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

# Part II — WS-S: Private P2P Rooms (End-to-End Encrypted)

*Source spec: `docs/PRIVATE_SPEC.md`. The plane-specific overview (room-class model, server-non-storage integration points, relationship notes, and conventions) follows; then the 67 WS-S cards (WS-S.0 framing → WS-S.11 audit/launch). The cross-plane back-matter is unified at the end of the document.*

> **Implementation status (current).** The **WS-S foundation is shipped** — landed FIRST exactly as this plan prescribes ("the defensive server gates ship first, so a partially-built P2P client can never accidentally write server content"). Complete: **WS-S.0.1** the three §4.1 room axes (`storage_mode`/`authority_model`/`directory_mode`) + the `roomAxesSchema` coherence refinement (the SSOT the DB CHECKs mirror) + `roomClassOf` + the `unlisted` p2p default, in `@licio/shared`; the **WS-S.0.2/0.3** honest-limits copy SSOT (`packages/shared/src/constants/private-rooms.ts` — the §6 creation/removal disclosures, the five §20.2 acknowledgments, the §20.1 "Members-only server room" labels, the Appendix E privacy matrix — locale-ready BLOCKING copy pinned by a prohibited-language copy-lint; the UI render is WS-S.7/9.1); **all of WS-S.1** — the server non-storage gates keystone (**1.1** the `rooms` axes + the six §23.2 coherence CHECKs, migration `0043`, with `RoomRecord.storageMode` threaded through the in-memory + Drizzle stores; **1.2** `private_room_stubs` + `private_rendezvous_records`, migration `0044`, with the strict §8.2 column allowlist enforced by `checkPrivateServerTables()` and NO room FK on the rendezvous record; **1.3** the submission `409 p2p_room_requires_client_sync` / contribution `404` / feed `p2p_room_local_only` rejection guards; **1.4** the retriever/search/event-pipeline exclusion — every retriever + the room surface predicate `roomStorageMode === 'server'`, server search excludes p2p docs in-memory + in SQL, the event router refuses any content event referencing a p2p room; **1.5** the seven §23.10 CI gates proven to bite + `check:no-applause`/`check:no-raw-egress` extended over `packages/private-p2p`); and **all of WS-S.2** — **2.1** the code-split `@licio/private-p2p` workspace (depends on `@licio/shared` only; registered in all four `check-workspace-deps` maps + a dedicated private-chunk bundle budget excluded from the core 320 KiB total), **2.2** the zero-dependency canonical DAG-CBOR encoder/decoder (the ONE deterministic profile; matches LCAP's LDC rules; fail-closed reject matrix + §27 caps; pinned by the P1/P2/P3 + integer-boundary + bomb-abort suite), **2.3** every strict §10/§13/§19 private schema (the §10.4 envelope EXTENDED so a verifier reconstructs both §10.5 AADs from it; the §13 manifest/op-bodies/attachment/search; the §10.3 invite + §12.3 join; the §19.4 report — contribution ops REUSE the shipped WS-G constants so the typed rules cannot drift). **The entire WS-S.3 cryptographic foundation is now shipped** (`packages/private-p2p/src/crypto/`, every primitive a thin RFC-vector-pinned WebCrypto wrapper): **3.1a** the minimal `ts-mls` MLS wrapper (RFC 9420; the suite `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` pinned at module load; the `check:p2p-mls-wrapper` gate forbids a deep `ts-mls` import elsewhere); **3.1b** the epoch bridge (`room_epoch_secret` = MLS-Exporter over `canonical([room_id_commitment, epoch, manifest_commitment])` → the five-key schedule; atomic rotation per commit; manifest-fork divergence); **3.2** `HKDF-Expand-Label` + the five room keys (RFC 5869 Appendix-A vectors); **3.3a/b** the §10.5 two-layer AES-256-GCM object AEAD (canonical `body_aad`/`wrap_aad`, the epoch-bound key-wrap replay defense, §25.4 padding, the §10.6 pad-not-compress rule); **3.4** the HPKE base-mode invite bootstrap (RFC 9180 suite A.1 hand-rolled over WebCrypto X25519/HKDF/AES-GCM, pinned to an `@hpke/core` interop ciphertext + RFC 7748 §6.1 DH, fragment-only URLs); **3.5** Ed25519 device signatures over the canonical envelope (cross-validated byte-for-byte against `@noble/curves`, an independent RFC 8032 impl); **3.6a** the §10.8 four-tier key store (Argon2id-passphrase/non-extractable/passkey-PRF/local-agent + the high-risk-tier policy, AAD-bound to room+tier); **3.6b** the §12.6/§12.7 portable recovery kit (re-derive on a new device with NO platform involvement; the `check:no-p2p-server-content` umbrella now forbids a server recovery endpoint, scoped so WS-D account recovery is never flagged); **3.6c** §12.6.1 capability-based threshold recovery (`evaluateRecoveryThreshold` counts M DISTINCT recover-capable admins, NOT secret-sharing — the op carries no key material; a successful recovery is an ordinary `member.add` = MLS Add + epoch rotation); **3.7** the forward-secrecy + nonce-uniqueness + fail-closed fuzz property suite.  Vetted deps (§6.12.12, all MIT, no install scripts, code-split private chunk): `ts-mls` (+ its `@noble/ciphers`/`@noble/curves` peers) + `@noble/hashes` (Argon2id); `ts-mls` is not yet formally audited (its disclaimer), isolated behind the one-file wrapper for a future swap.  **The §9.4 content-addressing (WS-S.4.2 — the dependency-free CIDv1-over-ciphertext profile, `crypto/cid.ts`, pinned byte-for-byte to `multiformats` + RFC 4648) and the COMPLETE §14.3 deterministic operation-log reducer (WS-S.5.1–5.8 — `reducer/`: the Lamport clock + canonical total order, the §11.3 capability model, the authority-enforcing pure fold + the §14.4 conflict policy, `roomStateCommitment`, the structural §14.2 pre-pass, the §14.2 stage-1 op wire-codec `sealOp`/`openOp`, the §14.5 verify-before-use snapshots, the §14.6 device-local moderation overlays, and the §13.7 local-only encrypted search; byte-identical reducer state across 25 shuffled op-delivery orders, §14.3.3/§26.1) are shipped** — the maintainer-chosen lighter-transport path (no Helia).  **The WS-S.6 P2P sync-decision plane is also shipped as a pure, transport-independent core (WS-S.6.1–6.5, `packages/private-p2p/src/sync/`):** the §15.2/§15.3 blind rendezvous (HMAC-SHA256 blind ids over canonical messages, the §15.3.1 "rendezvous_key IS the capability" property, sealed announcements AAD-bound to the record, the §15.3.2 coarse-bucket/jitter/cover/high-risk-steering mitigations); the §15.4 encrypted signaling (the opaque server-routed `EncryptedSignal`) + relay-only ICE suppression, over the X25519-ECDH transcript-bound pairwise secure channel (`crypto/ecdh.ts` + `sync/secure-channel.ts`); the §15.5 membership-proving handshake (device-key proof over a room/epoch/ephemeral-bound transcript, fail-closed admission, epoch-bound session key); the §15.6/§15.7/§15.8 head announcement + frontier-first reconciliation + fetch-order priority + block request/response + refuse-large/backoff; and the §15.9 offline encrypted-archive (CAR) exchange whose import re-runs §14.2 stage-1 on every envelope (no container-conferred trust).  **The WS-S.6.6 server-blind rendezvous endpoint is also shipped** (`apps/api/src/private-rendezvous/` + `POST /v1/private-rendezvous/{announce,poll,signal,signal/poll}`): opaque-only blind ids + ciphertext + a server-clamped TTL, the §15.3.1 no-existence-oracle (poll always returns a bounded list, never 404), aggregate-only metrics, IP-free global rate limits, CSRF-exempt; presence persists to the migration-`0044` `private_rendezvous_records` table behind a gated Postgres adapter while signals stay transient; the server deliberately does NOT import `@licio/private-p2p` (it is blind).  **The WS-S.4.3 live private-p2p WebRTC carrier is now shipped** (`apps/web/src/private-p2p/connect-peer.ts` `connectPrivatePeer`): it composes the §15.2/§15.3 blind rendezvous + the §15.4 X25519-ECDH SEALED signaling + the §15.5 membership-proving handshake into a real `RTCPeerConnection` → a post-handshake `PeerChannel` (the private plane's OWN driver, no shared crypto with LCAP), fail-closed (the remote device is proven REGISTERED + ACTIVE at the epoch BEFORE any op frame is served; a `MessageInbox` buffers so a first frame is never lost).  `rendezvous-client.ts` (`httpRendezvousTransport`) is the zod-validated fetch transport over `POST /v1/private-rendezvous/*`; `PrivateRoomSession.connect()` wires it to `PrivateSyncSession` (the §15.7 op-exchange) so two REAL engines converge to byte-identical reduced state, driven by a "Connect & sync with members" control in `PrivateRoomView`. **WS-S.10 the hardened update channel is shipped** (`packages/shared/src/update/` `verifyUpdateManifest`/`decideUpdateActivation` — maintainer Ed25519 signature + RFC 9162 transparency-log inclusion + running-bundle digest, fail-closed UNTRUSTED ⇒ rooms locked; `apps/web/src/update/` client gate + SW pinning; the new `check:update-channel` CI gate; `ensurePrivateBundleTrusted()` in `PrivateRoomSession.{create,load}`/`loadPrivateRoomEngine`). **WS-S.9 server→private migration is functional** (`apps/api/src/forum/migration-export.ts` export/freeze/purge — steward-gated, p2p-refusing, freeze-before-purge fail-closed via migration `0047`'s `frozen` flag; the 6-phase `MigrationWizard` + the `/private/migrate` route + `apps/web/src/private-p2p/migrate.ts` `reauthorIntoPrivateRoom` re-authoring through `planMigration`). **WS-S.11 the audit suite is shipped** (a 3+-peer convergence matrix, the no-server-content umbrella audit, the rendezvous-privacy audit — which fixed a latent `DrizzleRendezvousStore.poll` Date-bind bug — and a pinned known-answer SAS vector).  The remaining plane is the full two-browser create→invite→join→connect→converge E2E on real browser radios + the WS-S.9 server-export wizard polish. See `docs/private-p2p/README.md` for the per-card mapping and `packages/private-p2p/` + `packages/db/` + `apps/api/src/` for the code.

## Overview

WS-S implements **Private P2P rooms** (`docs/PRIVATE_SPEC.md`): rooms whose content, threads, comments, media, membership internals, and private search state are **end-to-end encrypted and hosted by members' devices**, not by the Licio main server. This is a *separate storage, sync, trust, and authority plane* — **not** a stronger flag on the existing server-hosted private-room model (which WS-Q calls a "restricted/members-only server room"). Platform staff cannot read, alter, recover, moderate, add members to, or delete private-room content because the platform never possesses content, keys, heads, or authoritative membership state.

Three room classes coexist (PRIVATE_SPEC §4):

| Internal class | UI label | Storage | Authority | Server reads? | Ranks/searches? |
|---|---|---|---|---:|---:|
| `public_server` | Public room | Licio server | Platform + room roles | Yes | Yes |
| `restricted_server` | Members-only server room | Licio server | Platform + room roles | Yes | Server-local only |
| `private_p2p` | **Private P2P room** | Member devices / encrypted pins | **Room keys only** | **No** | **No** |

The keystone is the **server non-storage contract** (PRIVATE_SPEC §8): for `storage_mode = 'p2p'` the server MUST NOT store or derive any private content, private CID, operation head, story/thread/contribution id, member list, activity state, search/ranking data, push content, or key/invite/recovery secret — only (optionally) a minimal directory stub and blind rendezvous records. Three security tiers (§3.2) set honest expectations: Tier 1 (PWA private) protects against passive server-storage compromise and ordinary administration but **not** a malicious Licio web update; Tier 2 (hardened PWA, update pinning) and Tier 3 (local key agent) reduce update-channel risk.

WS-S is **mostly net-new code** in a new shared workspace + a lazily code-split web module, plus tightly-scoped *defensive* guards on existing server surfaces so a P2P room id can never create server content.

### Verified integration points (current code)

| Concern | Symbol / file | WS-S change |
|---|---|---|
| Room axes (wire) | `roomVisibilitySchema`/`roomCreateRequestSchema` / `packages/shared/src/schemas/room.ts` | add `storage_mode`, `authority_model`, `directory_mode`; coherence `superRefine`; `can_post` false/omitted for p2p server projections |
| Room axes (storage) | `rooms` / `packages/db/src/schema/room.ts` | `storage_mode`/`authority_model`/`directory_mode`/`p2p_stub_id` columns + coherence CHECKs (PRIVATE_SPEC §23.2) |
| New server tables | `packages/db/src/schema/private-room.ts` (new) | `private_room_stubs`, `private_rendezvous_records` (strict field allowlists; §8.1 denylist as column denylist) |
| Submission guard | `apps/api/src/ingestion/submission.ts` | reject `storage_mode = 'p2p'` BEFORE auto-join/visibility derivation → `409 p2p_room_requires_client_sync` |
| Contribution guard | `apps/api/src/forum/contributions.ts` (+ routes) | reject p2p thread/room ids (defense in depth; p2p ids never exist server-side) |
| Ranking retrievers | eight retrievers + `RoomSurfaceRetriever` / `apps/api/src/ranking/retrievers.ts` | every retriever predicates `rooms.storage_mode = 'server'`; p2p never retrieved |
| Search | `SearchIndex` / `apps/api/src/ingestion/search.ts` | index + query only `storage_mode = 'server'` rooms |
| Event pipeline | `licioEventSchema`/router / `apps/api/src/events/` | validation gate: an event referencing a p2p room → reject + security metric |
| Uploads | `apps/api/src/forum/safety.ts` upload path | server uploads never attach to p2p content; client hides server-upload UI in p2p rooms |
| New API routes | `apps/api/src/routes/private-rooms.ts`, `private-rendezvous.ts` (new) | `/v1/private-rooms/*`, `/v1/private-rendezvous/*` (stubs + blind signaling only) |
| New shared package | `packages/private-p2p/` (new) | schemas, crypto (MLS/HPKE/AEAD/KDF/signatures/canonical), IPLD/CID/CAR, reducer, sync |
| New web module | `apps/web/src/private-p2p/` (new, lazily code-split) | Helia/libp2p node, key store/agent, sync engine, room DB + reducer worker, UI |
| Update channel | WS-O reproducible build + transparency log; `apps/web/public/sw-push.js` | sign/hash-pin the private-mode bundle; SW update pinning; lock private rooms on unverified bundle |
| CI gates | `scripts/` + `package.json` | `check:no-p2p-server-content`, `check:no-private-cid-egress`, `check:private-rendezvous-schema`, `check:private-bundle-transparency`, `check:p2p-endpoint-rejections`, `check:p2p-ranking-exclusion`, `check:p2p-search-exclusion` |

### Relationship to other specs and workstreams

- **WS-R / `docs/OFFLINE_SPEC.md` (LCAP).** WS-S owns the *authority and confidentiality* plane; WS-R is a complementary *availability and transport* substrate. WS-S MAY reuse the LCAP `.licio-bundle` pack as its encrypted CAR (§15.9), the lane scheduler so membership/control material outruns media, and LCAP liveness/trust labelling — but LCAP only ever sees ciphertext + opaque room hints for private rooms. The planes pin different suites on purpose (Ed25519/MLS here; ES256 in LCAP) and never share keys.
- **WS-Q.** WS-S adds the `private_p2p` class as a third room class orthogonal to WS-Q's binary public/private *server* visibility; WS-Q's "private room" is renamed "members-only server room" so "private" in the strong sense is reserved for `private_p2p` (§20.1).
- **WS-D / Section 19.1.** Rendezvous and stub-creation rate limiting key on a non-reversible account reference, never an IP, matching the shipped identity-free posture.
- **WS-G.** Private contribution validation mirrors the shipped WS-G typed rules (body caps, citations for evidence/corrections, answer→question parent, depth cap, lens-belongs-to-room) — locally, on decrypted state.

### Conventions for this workstream

- **Server non-knowledge (ABSOLUTE, §8).** The §8.1 forbiddance list is enforced structurally: a column denylist on the stub/rendezvous tables, endpoint rejection guards, retriever/search predicates, an event-pipeline gate, and seven CI checks. Any path that could place private content/CIDs/heads/member-lists/keys on the server is a release-blocking violation.
- **Encrypt before content-address (ABSOLUTE, §9.1).** A plaintext CID MUST never exist for private-room content; the CID always identifies ciphertext. The render path MUST reject any attempt to construct a public-gateway URL for a private CID.
- **No custom group crypto (ABSOLUTE, §10.3).** Group keying is MLS (RFC 9420); invite bootstrap is HPKE (RFC 9180); no hand-rolled ratchet. WebCrypto is wrapped behind small, reviewed modules; primitives are audited libraries.
- **Canonical encoding pinned (§10.1.1).** Every structure that is hashed into a CID, fed to an AEAD as AAD, signed, or compared for reducer determinism uses the one DAG-CBOR deterministic profile in `packages/private-p2p/src/crypto/canonical.ts`, pinned by stability tests.
- **Honest non-goals (ABSOLUTE, §6).** The UI states the limits everywhere they matter: members can copy/leak content; removal is not retroactive deletion; availability depends on member devices/pins; Licio cannot recover lost keys; Tier 1 does not defend against a malicious web update. Support docs MUST NOT promise impossible recovery/moderation.
- **No platform-role authority (§11.4).** No platform role (`admin`, `steward`) and no support/emergency key can read, add members to, moderate, recover, or unlock a P2P room. Platform staff may only delist a listed directory stub or suspend a Licio account's access to Licio-hosted services.
- **Dependency-budget isolation (§9.8).** Helia/libp2p/MLS/HPKE/Argon2 live in `packages/private-p2p` (workspace, excluded from the `apps/web` < 15 direct-dep count) and a dynamically-imported route chunk loaded only on first private-room use; the core PWA's initial-bundle gate (< 200 KB gz) MUST NOT regress.
- **Naming discipline (§20.1).** "Public room" / "Members-only server room" / "Private P2P room." Server-hosted restricted rooms are never called "private" without a qualifier; only `private_p2p` is "private" in the strong sense.
- **Fail-closed.** Unknown ops, unverified bundles, unauthorized signers, missing parents, and undecryptable envelopes all fail closed; quarantined/unsupported ops never render.
- **Task sizing (Section 30.8).** Every card is one deliverable — one schema, one crypto module, one op type, one guard, one endpoint, one UI panel — reviewable, testable, and reversible in ≤ 1-3 engineering days. Sub-area headers map to PRIVATE_SPEC §28's WS-P2P-0…11; the dependency graph at the end fixes their order.

---

## WS-S.0 Terminology, room-class model, and product framing

### WS-S.0.1 Three-room-class model + shared room axes
**ID:** WS-S.0.1 | **Ref:** PRIVATE_SPEC §4, §4.1; WS-P2P-0

**Description:** In `packages/shared/src/schemas/room.ts` add the three axes as `z.enum`s — `ROOM_STORAGE_MODES = ['server','p2p']`, `ROOM_AUTHORITY_MODELS = ['platform','room_keys']`, `ROOM_DIRECTORY_MODES = ['listed','unlisted','detached']` — with inferred types, and a `superRefine` enforcing the §4.1 coherence: `storage='server' ⇒ authority='platform'`; `storage='p2p' ⇒ authority='room_keys' ∧ visibility='private' ∧ join_model='invite'`; for p2p, `posting_policy` is advisory UI only (real posting is capability-gated). Default `directory_mode='unlisted'` for p2p. Server room projections set `can_post=false`/omit it for p2p (posting is local).

**Acceptance criteria:**
- The coherence refinement accepts every legal triple and rejects each illegal one (e.g. `p2p`+`platform`, `p2p`+`public`).
- Default directory mode for p2p is `unlisted`; `listed` requires explicit action.
- No applause/financial field appears on any room shape (existing denylist tests stay green).

**Testing:** Unit — coherence accept/reject matrix; default-application; `expectTypeOf` for the new fields.

**Dependencies:** WS-Q (binary room visibility) complete.

---

### WS-S.0.2 Restricted-server-room rename + privacy promise matrix
**ID:** WS-S.0.2 | **Ref:** PRIVATE_SPEC §20.1, Appendix E

**Description:** Rename the WS-Q server-hosted "private" room to **"Members-only server room"** across UI copy and docs (the storage/authority model is unchanged — this is a labelling correction). Add the §Appendix E user-facing privacy matrix (Public / Members-only server / Private P2P across: can Licio host? can admins access? can content be globally ranked? can Licio recover? can members leak? can removed members read old content? does availability depend on member devices? are public gateways used?). "Private" without a qualifier is reserved for `private_p2p`.

**Acceptance criteria:**
- No server-hosted restricted room is labelled simply "private" anywhere in UI or docs.
- The privacy matrix renders and is referenced from each room class's creation/info surface.

**Testing:** Unit — copy-lint that "private" is qualified for server rooms; matrix render snapshot. E2E (axe) — matrix accessibility.

**Dependencies:** WS-S.0.1.

---

### WS-S.0.3 Mandatory creation/removal/limit disclosure copy
**ID:** WS-S.0.3 | **Ref:** PRIVATE_SPEC §6, §20.2, §20.5

**Description:** Add the §6 honest-limits copy as i18n-catalog entries: the mandatory creation disclosure ("Licio does not host the room's content and cannot read, moderate, recover, or add members… removed members may keep content… members can copy… keep a recovery kit"), the removal disclosure ("stops future reading after keys rotate; cannot delete/recall content already downloaded"), and the five mandatory creation acknowledgment checkboxes. These are blocking copy, not advisory.

**Acceptance criteria:**
- Creation cannot proceed without all five acknowledgments; the disclosure text matches §6 exactly.
- Removal dialog shows the non-retroactive-deletion disclosure.
- All copy is locale-ready and passes the prohibited-language scan (no false "secure"/"deleted everywhere").

**Testing:** Unit — gating on acknowledgments; copy presence. E2E — creation/removal disclosure flow.

**Dependencies:** WS-S.0.2.

---

## WS-S.1 Server schema and hard non-storage gates

### WS-S.1.1 Room axes DB migration + coherence CHECKs
**ID:** WS-S.1.1 | **Ref:** PRIVATE_SPEC §23.2; WS-P2P-1

**Description:** In `packages/db/src/schema/room.ts` add `room_storage_mode`/`room_authority_model`/`room_directory_mode` enums and the `storage_mode` (NOT NULL DEFAULT `'server'`), `authority_model` (NOT NULL DEFAULT `'platform'`), `directory_mode` (nullable), `p2p_stub_id` (nullable) columns, with the §23.2 CHECK constraints enforcing **every** §4.1 coherence rule structurally: storage↔authority coherence, `p2p ⇒ directory_mode NOT NULL`, `p2p ⇒ visibility='private'`, `p2p ⇒ join_model='invite'`, and `server ⇒ p2p_stub_id IS NULL`. The `p2p ⇒ join_model='invite'` CHECK reuses the WS-Q `join_model` column and closes the gap where a direct write / migration / old API path could persist a P2P room with `open` or `request_approval` that the shared schema rejects but the DB would otherwise accept. The migration is additive (defaulted columns) following the WS-Q expand pattern; existing rooms remain `server`/`platform`.

**Acceptance criteria:**
- Migration is additive + idempotent with a clean down path; no existing row is rewritten.
- The five CHECKs reject every incoherent row (p2p+platform, p2p+public, p2p+`open`/`request_approval`, server-with-stub, p2p without directory).
- DB enums mirror the shared enums exactly; the join-model CHECK matches WS-S.0.1's `superRefine` so the storage layer and the wire schema agree.

**Testing:** Gated integration (Postgres) — apply/rollback; CHECK-violation cases. Unit — DB↔shared enum mirror.

**Dependencies:** WS-S.0.1.

---

### WS-S.1.2 `private_room_stubs` + `private_rendezvous_records` tables
**ID:** WS-S.1.2 | **Ref:** PRIVATE_SPEC §8.2, §15.3, §23.2

**Description:** Add `packages/db/src/schema/private-room.ts`: `private_room_stubs` carrying ONLY the §8.2 allowed fields (stub id, room_server_id, directory_mode, listed-only display name/description/avatar public CID, room public key, manifest/latest-manifest commitments, rendezvous policy, bootstrap hints, signed stub + signature, creator account, timestamps) and `private_rendezvous_records` (room_blind_id, peer_blind_id, encrypted_announcement, expires_at). The §8.1 forbiddance list is the **column denylist** for both tables — no content/CID/op-head/member/activity/key/secret column may exist. Short TTL + size caps on rendezvous rows.

**Acceptance criteria:**
- Neither table has any column that could hold private content/CIDs/heads/member lists/keys; a schema test asserts the denylist.
- For `detached` rooms, no stub row is created; `unlisted` stores only the opaque stub.
- Rendezvous rows carry only blind ids + ciphertext + TTL and auto-expire.

**Testing:** Gated integration — table shape + TTL expiry. Unit — column-denylist assertion (`check:private-rendezvous-schema`).

**Dependencies:** WS-S.1.1.

---

### WS-S.1.3 Endpoint rejection guards (submission / contribution / upload)
**ID:** WS-S.1.3 | **Ref:** PRIVATE_SPEC §21.6, §23.3, §23.4, §23.8

**Description:** Add the defensive guards: in `apps/api/src/ingestion/submission.ts`, **before** auto-join/visibility derivation, reject `room.storageMode === 'p2p'` with `409 p2p_room_requires_client_sync`; in the forum contribution routes/services, reject p2p thread/room ids (defense in depth — p2p ids should never exist server-side); in the upload path, refuse to attach uploads to p2p content and hide server-upload UI inside p2p rooms. `GET /v1/rooms/:id/feed` for a p2p room returns the `p2p_room_local_only` response; `GET /v1/search` never returns p2p content.

**Acceptance criteria:**
- A `POST /v1/stories`/`/v1/contributions` with a p2p room/thread id returns the documented 409 and creates no row.
- The p2p feed endpoint returns local-only guidance; server upload attach to p2p is rejected.
- The guard runs before any side effect (no thread shell, no event emission).

**Testing:** Gated integration — each endpoint's p2p rejection (`check:p2p-endpoint-rejections`); no-row-created assertion.

**Dependencies:** WS-S.1.1.

---

### WS-S.1.4 Retriever / search / event-pipeline exclusion
**ID:** WS-S.1.4 | **Ref:** PRIVATE_SPEC §23.5, §23.6, §23.7

**Description:** Predicate every ranking retriever (the eight organic + the room-surface scoper) and the search index/query on `rooms.storage_mode = 'server'` so p2p content can never enter global/topic/room surfaces or search. Add an event-pipeline validation gate: an event payload referencing a p2p room → reject + security metric (private-room events should never be emitted, so the gate catches bugs).

**Acceptance criteria:**
- No retriever or search path can return p2p content; the predicate is on every candidate source.
- An event referencing a p2p room is rejected with a security metric, never processed.
- The ranking-neutrality + containment suites extend to assert p2p exclusion.

**Testing:** Gated integration — retriever/search exclusion (`check:p2p-ranking-exclusion`, `check:p2p-search-exclusion`); event-gate rejection.

**Dependencies:** WS-S.1.1.

---

### WS-S.1.5 Server non-storage CI gates + DB assertion suite
**ID:** WS-S.1.5 | **Ref:** PRIVATE_SPEC §23.10, §26.4, Appendix D

**Description:** Add the seven §23.10 CI gates (`check:no-p2p-server-content`, `check:no-private-cid-egress`, `check:private-rendezvous-schema`, `check:private-bundle-transparency`, `check:p2p-endpoint-rejections`, `check:p2p-ranking-exclusion`, `check:p2p-search-exclusion`) and the Appendix D `assertNoP2PServerContent(roomId)` post-E2E DB assertion (stories/threads/search/ranking-candidates/events-payload/uploads all count 0 for a p2p room). `check:no-private-cid-egress` scans server logs/source for private CID/op-id/invite-fragment patterns.

**Acceptance criteria:**
- All seven gates run in CI; each fails on an injected violation fixture.
- After a full P2P E2E run, the DB assertion proves zero private content rows for the room.
- Server logs exclude private CIDs/op ids/invite fragments/member lists/thread titles/bodies/exact activity (§27.1).

**Testing:** The gates themselves (positive + negative fixtures); Appendix D assertion after the WS-S.11.3 E2E.

**Dependencies:** WS-S.1.2, WS-S.1.3, WS-S.1.4.

---

## WS-S.2 Private schemas and canonical encoding

### WS-S.2.1 `packages/private-p2p` scaffold + dependency-budget isolation
**ID:** WS-S.2.1 | **Ref:** PRIVATE_SPEC §9.8, §22.1

**Description:** Create the `@licio/private-p2p` workspace with the §22.1 source tree (`schemas/`, `crypto/`, `ipld/`, `reducer/`, `sync/`, `testing/`), TS strict, SPDX headers, depends on `@licio/shared` only (never `@licio/db`). All heavy dependencies (Helia, libp2p + transports, the chosen MLS lib, HPKE lib, Argon2/curve fallback) are declared **here**, not in `apps/web` — the workspace is excluded from the `apps/web` < 15 direct-dep count. Two gate updates are mandatory and part of this card: **(1) register `@licio/private-p2p` in `scripts/check-workspace-deps.ts`** (all four maps; allowed deps `['@licio/shared']`) so the hard-coded boundary gate actually scans it — otherwise a forbidden `@licio/db` import is invisible while the check passes; **(2) update `scripts/check-bundle-size.ts`** — the private chunk is code-split out of the initial-load payload, but that script also enforces a **320 KiB gzipped TOTAL-JS budget across every built asset including lazy chunks**, which the Helia/libp2p/MLS chunk would blow even with first-load unchanged. Give the private-p2p chunk its **own measured budget** and exclude it from the core 320 KiB total (e.g. an `excludePattern`/separate-budget bucket keyed on the private chunk's stable name), so the core total stays meaningful and the private chunk is bounded against its own ceiling. Document the dedicated `check:deps` allowance and confirm the web consumer is a dynamically-imported chunk (§9.8).

**Acceptance criteria:**
- `pnpm --filter @licio/private-p2p build/test` run standalone; `check:workspace-deps` includes the workspace and FAILS on a planted `@licio/db` import fixture.
- `apps/web` direct-dep budget, the **200 KiB initial-load**, and the **320 KiB core-total** gates are all unchanged by the core app; the private chunk is measured against its **own** documented budget, not the core total.
- Each dependency passes the CLAUDE.md review (maintained, install-script-free, AGPL-compatible); choices tracked in §30.1–§30.2.

**Testing:** CI — workspace-boundary (with planted-violation fixture) + dep-budget + the split core-total/private-chunk bundle-size gates green; export smoke test.

**Dependencies:** none (new workspace; depends on `@licio/shared`).

---

### WS-S.2.2 Canonical DAG-CBOR encoder + stability tests
**ID:** WS-S.2.2 | **Ref:** PRIVATE_SPEC §10.1.1, §9.4

**Description:** Implement `packages/private-p2p/src/crypto/canonical.ts`: the DAG-CBOR deterministic profile (RFC 8949 §4.2.1 core determinism — shortest-form integers, definite-length only, bytewise-lexicographic map-key order, no duplicate keys, no floats, omit-not-null optionals, UTF-8/NFC text), matching LCAP's LDC rules. This is the single `canonical(...)` referenced by every AAD, signature, CID, and reducer comparison. Pin it with stability vectors.

**Acceptance criteria:**
- `canonical(value)` is byte-stable and equals committed vectors; two encoders agree.
- Non-deterministic input (unsorted/duplicate keys, indefinite length, floats) is rejected on decode.
- The encoder is shared by the IPLD/CID layer (§9.4) so ciphertext-block CIDs are reproducible.

**Testing:** Unit — encode/decode/reject matrix; stability-vector replay; "equal value ⇒ equal bytes" property.

**Dependencies:** WS-S.2.1.

---

### WS-S.2.3 Envelope + object schemas
**ID:** WS-S.2.3 | **Ref:** PRIVATE_SPEC §10.4, §13

**Description:** Define the strict zod schemas in `packages/private-p2p/src/schemas/`: `PrivateEncryptedEnvelopeV1` (§10.4), the plaintext manifest (§13.1), the op envelope + the eleven op bodies (membership/role/story/thread/contribution/summary/attachment/snapshot, §13.2–13.6), invite secret (§10.3), join request (§12.3), attachment manifest (§13.6), local search shard (§13.7), and the voluntary report package (§19.4). Private contribution validation mirrors the WS-G typed rules (body caps, citations for evidence/corrections, answer→question parent, depth cap, lens-belongs-to-room) on decrypted state.

**Acceptance criteria:**
- Every schema is `.strict()`; unknown fields reject; forward compat is by schema-version bump.
- Contribution ops enforce the same typed requirements as the shipped WS-G server schema.
- The envelope's authenticated metadata matches the AAD inputs (WS-S.3.3a) exactly.

**Testing:** Unit — accept/reject per schema; WS-G-parity matrix for contribution ops; envelope↔AAD field alignment.

**Dependencies:** WS-S.2.2.

---

## WS-S.3 Cryptographic foundation

### WS-S.3.1a MLS library integration + cipher-suite pin + group lifecycle
**ID:** WS-S.3.1a | **Ref:** PRIVATE_SPEC §10.2, §30.1; §10.7

**Description:** Integrate the chosen audited TypeScript/WASM MLS implementation (RFC 9420) behind a **minimal reviewed wrapper** `packages/private-p2p/src/crypto/mls.ts` exposing only `createGroup`, `generateKeyPackage`, `addMember(keyPackage)`, `removeMember(leafIndex)`, `commit`, `processWelcome`, `currentEpoch`, and `epochAuthenticator`. Pin the cipher suite explicitly (the X25519/AES-128-GCM-or-ChaCha20/SHA-256/**Ed25519** suite that aligns with §10.7's signature choice) — never "library default" at runtime. Map one room = one MLS group, one device = one MLS client. Replay official MLS test vectors where the library exposes them. The wrapper surface is the only MLS API the rest of `packages/private-p2p` may call (a lint rule forbids deep imports of the MLS library).

**Acceptance criteria:**
- `addMember`/`removeMember`/`commit` advance `currentEpoch`; `processWelcome` admits a new device into the group at the committing epoch.
- The cipher suite is pinned in code and asserted; an unexpected suite from the library aborts initialization.
- Only the wrapper surface is reachable; a deep MLS-library import fails the lint gate. Official vectors pass where available.

**Testing:** Unit/gated — add/remove/commit/welcome across simulated devices; suite-pin assertion; deep-import lint; official-vector replay.

**Dependencies:** WS-S.2.3.

---

### WS-S.3.1b Epoch exporter → `room_epoch_secret` + epoch-transition wiring
**ID:** WS-S.3.1b | **Ref:** PRIVATE_SPEC §10.2, §10.9

**Description:** Implement `roomEpochSecret(epoch)` = `MLS-Exporter("licio.private-room.v1.epoch", canonical([room_id_commitment, epoch, manifest_commitment]), 32)` (RFC 9420 §8.5) over the current group's exporter secret, and the **epoch-transition event** that fires whenever a commit changes the epoch: it recomputes `room_epoch_secret`, triggers the §10.2 key schedule (WS-S.3.2) to rotate all five operational keys atomically, rotates the sync topic and rendezvous blind ids (WS-S.6.1a), and bumps the manifest commitment. The exporter context binds `manifest_commitment` so a fork of the manifest yields a different secret. Determinism: the same group state + epoch yields the identical `room_epoch_secret` on every device.

**Acceptance criteria:**
- `room_epoch_secret` is reproducible from the exporter and bound to `(room, epoch, manifest_commitment)`; identical across devices at the same epoch.
- A commit emits exactly one epoch-transition event that rotates keys + topics + blind ids atomically (no window where old and new coexist).
- A manifest fork (different `manifest_commitment`) produces a different secret, so cross-fork content cannot be opened.

**Testing:** Unit/gated — exporter determinism across devices; one-event-per-commit atomic rotation; manifest-fork divergence.

**Dependencies:** WS-S.3.1a.

---

### WS-S.3.2 HKDF-Expand-Label key schedule
**ID:** WS-S.3.2 | **Ref:** PRIVATE_SPEC §10.2

**Description:** Implement `HKDF-Expand-Label(secret, label, context, length)` (HKDF-SHA256, RFC 5869, TLS-1.3/MLS style: `HKDF-Expand(secret, encode(length, "licio-priv1 "||label, context), length)`, no separate Extract since the exporter secret is uniform) and derive the per-purpose keys from `room_epoch_secret`: `content_wrap_key`, `sync_topic_key`, `rendezvous_key`, `snapshot_key`, `report_key` — each with its label, `context = room_id_commitment`, length 32. One MLS Commit rotates all of them.

**Acceptance criteria:**
- Each derived key is reproducible, domain-separated by the `"licio-priv1 "`+label prefix, and 32 bytes.
- `context` is canonical-encoded, never ad-hoc concatenation; the five keys are mutually independent.
- A new epoch yields five new keys atomically.

**Testing:** Unit — derivation vectors; domain-separation independence; epoch rotation rotates all keys.

**Dependencies:** WS-S.3.1b.

---

### WS-S.3.3a Object-body AEAD + canonical `body_aad` + padding
**ID:** WS-S.3.3a | **Ref:** PRIVATE_SPEC §10.5, §10.6, §25.4

**Description:** Implement the inner AEAD in `packages/private-p2p/src/crypto/aead.ts`: `sealBody(plaintext, meta) → { object_key, nonce, ciphertext }` with a **fresh random 32-byte `object_key` per object** and a fresh nonce (96-bit for AES-256-GCM, 192-bit for XChaCha20-Poly1305) under the §10.5 `body_aad` = `canonical(["licio-priv1.body", envelope_version, room_id_commitment, room_epoch, object_type, plaintext_schema, sorted(parent_op_ids), author_device_id_blind, author_seq, capability_root_at_seq, chunk_index, chunk_total])`. Before sealing an op/contribution body, **pad to its size bucket** (§25.4) — compression-before-encryption is forbidden across the secret/attacker boundary (WS-S's §10.6 rule), so op bodies are padded, never compressed. `openBody` reconstructs `body_aad` from authenticated metadata + local epoch and fails closed on any mismatch.

**Acceptance criteria:**
- A fresh `object_key` + nonce is used per object; a test harness asserts nonce/key uniqueness across a generated workload (reuse is a hard error).
- `body_aad` is canonical-encoded (fixed-shape array, never `||`); `openBody` succeeds only when the reconstructed AAD byte-matches.
- Op/contribution bodies are padded to a size bucket and never compressed; a compression attempt on a secret body throws.

**Testing:** Unit — seal/open round-trip; AAD-field-flip rejection (each field); nonce/key-uniqueness invariant; pad-not-compress assertion.

**Dependencies:** WS-S.3.2.

---

### WS-S.3.3b Object-key wrap AEAD + epoch-bound replay defense
**ID:** WS-S.3.3b | **Ref:** PRIVATE_SPEC §10.4, §10.5

**Description:** Implement the outer AEAD wrapping the per-object `object_key` under the epoch `content_wrap_key`: `wrapKey(object_key, meta) → wrapped_object_key` where `wrap_nonce` is fresh, `wrap_aad = canonical(["licio-priv1.keywrap", wrapping_epoch, room_id_commitment, object_type])`, and the wire form is `wrapped_object_key = wrap_nonce || AEAD-Seal(content_wrap_key, wrap_nonce, object_key, wrap_aad)`. `unwrapKey` binds `wrapping_epoch` so an object key sealed at one epoch cannot be replayed into an envelope claiming another. This is the `key_wrap` field of `PrivateEncryptedEnvelopeV1` (WS-S.2.3). The full envelope = body ciphertext (S.3.3a) + `wrapped_object_key` (here) + author signature (WS-S.3.5).

**Acceptance criteria:**
- The object key round-trips through wrap/unwrap under `content_wrap_key`; the wire form prefixes the wrap nonce.
- An object key wrapped at epoch E fails to unwrap when the envelope claims epoch E′≠E (epoch-bound replay defense).
- The wrap is independent per object; no `content_wrap_key` nonce is reused (asserted).

**Testing:** Unit — wrap/unwrap round-trip; cross-epoch replay rejection; wrap-nonce uniqueness.

**Dependencies:** WS-S.3.3a.

---

### WS-S.3.4 HPKE invite bootstrap
**ID:** WS-S.3.4 | **Ref:** PRIVATE_SPEC §10.3, §12.2

**Description:** Implement HPKE (RFC 9180) invite sealing in `packages/private-p2p/src/crypto/hpke.ts` for one-to-one bootstrap before the recipient joins the MLS group: seal `InviteSecretV1` (room stub ref, room public key, invite id/secret, expiry, max uses, granted role, approval flag) to the recipient. The invite URL carries the sealed secret in the **fragment** (`…/private/join#invite=<base64url-sealed>`) so ordinary HTTP never transmits it to the server. Pin the HPKE suite + library and test with official vectors.

**Acceptance criteria:**
- The invite secret is HPKE-sealed; only the intended recipient opens it; the secret lives in the URL fragment only.
- Invite expiry/max-uses/role/approval are authenticated; a tampered invite fails to open.
- Official HPKE vectors pass; the suite is pinned.

**Testing:** Unit — seal/open round-trip; fragment-only assertion; vector replay; tamper rejection.

**Dependencies:** WS-S.3.1a.

---

### WS-S.3.5 Ed25519 signatures + WebCrypto/fallback
**ID:** WS-S.3.5 | **Ref:** PRIVATE_SPEC §10.7, §30.5

**Description:** Implement room-scoped (or room-epoch-scoped, to reduce linkability) Ed25519 device signing over the canonical-encoded envelope + all public metadata. Use WebCrypto `Ed25519`/`X25519` where `crypto.subtle` advertises support; otherwise fall back to an audited curve library (e.g. `@noble/curves` or libsodium-WASM) loaded **inside the lazily code-split private-p2p chunk**, never the core bundle. Final algorithm/suite pinned before implementation.

**Acceptance criteria:**
- Every op/envelope is Ed25519-signed over the canonical bytes + public metadata; signature verifies cross-runtime.
- WebCrypto is used where available; the fallback loads only in the private chunk and matches WebCrypto output on vectors.
- Device keys are room/epoch-scoped to reduce cross-room linkability.

**Testing:** Unit — sign/verify; WebCrypto↔fallback vector parity; linkability-scope assertion.

**Dependencies:** WS-S.2.2.

---

### WS-S.3.6a Local key store + four protection tiers + Argon2id KDF
**ID:** WS-S.3.6a | **Ref:** PRIVATE_SPEC §10.8, §16.2

**Description:** Implement the `LocalPrivateKeyRecord` store (IndexedDB, in the private chunk) holding room/epoch signing keys, MLS state secrets, and exporter material, with the four protection tiers selectable per room: (1) passphrase-wrapped via **Argon2id** (RFC 9106, or a similarly-reviewed memory-hard KDF, loaded in the private chunk); (2) WebCrypto **non-extractable** wrap (raw key never serializable — `exportKey` rejects, mirroring the WS-C draft-crypto posture); (3) passkey-assisted unlock; (4) a seam for the Tier-3 local key agent (WS-S.10.3). High-risk rooms require tier 2+ or strict update pinning. This card owns key-at-rest only; recovery is WS-S.3.6b/c.

**Acceptance criteria:**
- Keys are protected at the configured tier; the non-extractable tier's `exportKey` rejects and no JWK is ever at rest; passphrase exports use Argon2id with reviewed parameters.
- Tier selection is per-room and persisted; high-risk rooms cannot select the weakest tier without update pinning.
- The Argon2id/memory-hard KDF loads only inside the lazily code-split private chunk, never the core bundle.

**Testing:** Unit — per-tier protect/unlock; non-extractability assertion; Argon2id parameter pinning; chunk-isolation of the KDF.

**Dependencies:** WS-S.3.1a, WS-S.3.5.

---

### WS-S.3.6b Recovery kit + terminal lost-all-keys path
**ID:** WS-S.3.6b | **Ref:** PRIVATE_SPEC §12.6, §12.7, §16.2

**Description:** Implement the recovery kit: an encrypted member/device recovery capability (strong-passphrase- or hardware-bound) that lets a member re-derive their own access on a new device **without** any platform involvement. Implement the §12.7 terminality rule structurally: if all member keys for a room are lost, the room is **unrecoverable** — there is no platform recovery path, no support escalation, and the UI/support copy never implies one. The recovery kit export reuses the WS-S.3.6a key store + the honest-non-goals copy (WS-S.0.3).

**Acceptance criteria:**
- A recovery kit round-trips a member's access onto a new device with no server call; it is passphrase/hardware-bound and never stored server-side.
- A fully-lost room is terminal: no code path, support tool, or copy offers recovery (a static check forbids a "recover room" server endpoint).
- The recovery-kit creation flow shows the §12.7 "Licio cannot recover this for you" disclosure.

**Testing:** Unit — recovery-kit round-trip (new device); no-server-call assertion; lost-all-keys terminality; disclosure presence.

**Dependencies:** WS-S.3.6a.

---

### WS-S.3.6c Capability-based threshold recovery (M admin authorizations)
**ID:** WS-S.3.6c | **Ref:** PRIVATE_SPEC §12.6.1

**Description:** Implement **capability-based** threshold recovery (§12.6.1): M distinct admin-signed `RecoveryAuthorize` ops (each a normal authority-validated op, WS-S.5.1) combine to authorize an **MLS Add + epoch rotation** that re-admits a recovering member — explicitly **NOT** Shamir/secret-sharing of the room root key (no key material is ever reconstructed or transmitted). The M-of-N policy is room-configured; each authorization is an independent signed op counted by distinct admin device key, and the recovery completes through the normal membership-op + epoch-rotation path (WS-S.5.1/WS-S.3.1b).

**Acceptance criteria:**
- Threshold recovery counts **M distinct** admin authorizations via signed ops, not reconstructed key material; fewer than M, or M from non-distinct admins, does not authorize.
- A successful threshold recovery is an ordinary MLS Add + epoch rotation (removed/old epochs stay sealed); no root key is ever shared or rebuilt.
- The M-of-N policy is room-configured and enforced at validation time.

**Testing:** Unit — distinct-admin threshold counting; below-threshold rejection; recovery-as-MLS-Add path; no-secret-sharing assertion.

**Dependencies:** WS-S.3.6a, WS-S.5.1.

---

### WS-S.3.7 Crypto vectors, fuzzing, and nonce-uniqueness assertions
**ID:** WS-S.3.7 | **Ref:** PRIVATE_SPEC §26.2, §10.6

**Description:** Assemble `packages/private-p2p/src/testing/vectors.ts`: official HPKE vectors, MLS library vectors where available, canonical-encoding differential tests, envelope encrypt/decrypt vectors, signature vectors, and property tests — unauthorized ops never render; removed members cannot decrypt future-epoch test objects; nonce/object-key uniqueness holds under generated workloads (nonce reuse is asserted impossible). Fuzz malformed envelopes/ops.

**Acceptance criteria:**
- All official vectors pass; differential canonical-encoding tests pass.
- The "removed member cannot decrypt future epoch" and "unauthorized op never renders" properties hold.
- A nonce-reuse assertion runs across generated encryption workloads and is never violated.

**Testing:** Property + fuzz suite; vector replay; nonce/key-uniqueness invariant.

**Dependencies:** WS-S.3.3a, WS-S.3.3b, WS-S.3.4, WS-S.3.5.

---

## WS-S.4 Helia / libp2p private profile

### WS-S.4.1 Private Helia node + disabled public routing
**ID:** WS-S.4.1 | **Ref:** PRIVATE_SPEC §9.2, §9.3, §9.5

**Description:** Configure a separate Helia/libp2p node/namespace for private rooms (`LicioPrivateHeliaProfile`, §9.3) that DISABLES public DHT routing, public gateway fallback, delegated routing, IPNI advertisement, public Bitswap with unknown peers, public provider records, automatic reproviding of private CIDs, and permanent cross-room PeerIDs; mDNS off (or local-only-explicit); relay mode `direct_allowed|relay_preferred|relay_only`; PeerID scoped to room-epoch. The private node is fully isolated from any public-content Helia usage.

**Acceptance criteria:**
- Every public-routing surface is disabled in the private profile; a config test asserts each flag false.
- PeerIDs are room-epoch-scoped and rotate; no permanent cross-room identity exists.
- The private node shares no routing/announcement with public content.

**Testing:** Unit — profile-flag assertions (all public routing off). Gated — two private nodes connect only via the private profile.

**Dependencies:** WS-S.2.1.

---

### WS-S.4.2 CIDv1 ciphertext profile + IndexedDB blockstore
**ID:** WS-S.4.2 | **Ref:** PRIVATE_SPEC §9.1, §9.4, §16.1

**Description:** Implement the §9.4 CIDv1 ciphertext profile (cid v1, base32, sha2-256, dag-cbor small-object codec over ciphertext metadata, raw codec for large encrypted chunks, 256 KiB small / 1–4 MiB large chunk sizes) over the §16.1 IndexedDB-backed blockstore/datastore (`licio_private_blocks`/`_ops`/`_heads`/`_keys`/`_snapshots`/`_local_search`/`_outbox`/`_replication`/`_rooms`). The CID always identifies **ciphertext**; a plaintext CID for private content must never exist (the encrypt→pad→encrypt→chunk→CID pipeline of §9.1).

**Acceptance criteria:**
- Every private CID is over ciphertext; the pipeline encrypts before content-addressing; no plaintext CID is produced.
- The IDB blockstore stores/retrieves encrypted blocks by CID; large media chunks use the raw codec.
- The private stores are separate from public content and the WS-R `lcap_v2` DB.

**Testing:** Unit (`fake-indexeddb`) — store/retrieve by CID; ciphertext-only-CID assertion; chunk-size selection.

**Dependencies:** WS-S.3.3a, WS-S.4.1.

---

### WS-S.4.3 Private libp2p block-exchange protocols + membership gating
**ID:** WS-S.4.3 | **Ref:** PRIVATE_SPEC §9.6, §15.5, §15.7

**Status:** SHIPPED (realized over the maintainer-chosen WebRTC carrier, not libp2p): `connectPrivatePeer` (`apps/web/src/private-p2p/connect-peer.ts`) composes the §15.2/§15.3 blind rendezvous + §15.4 sealed signaling + the §15.5 membership-proving handshake into a real `RTCPeerConnection` → a post-handshake `PeerChannel`; a non-/removed-member device fails the handshake before any op frame is served (fail-closed), and the §15.7 op-exchange over the channel carries only verified ciphertext. Two real engines converge byte-identically; node-tested.

**Description:** Implement the Licio-specific libp2p protocols (`/licio/private/handshake/1`, `/heads/1`, `/block-request/1`, `/block-response/1`, `/snapshot/1`, `/range/1`, `/health/1`). Only peers that prove current-epoch room membership (WS-S.6.3 handshake) may speak these protocols for a room; public libp2p peers cannot request arbitrary private CIDs. All returned blocks are verified by CID + signature + AEAD before use.

**Acceptance criteria:**
- A non-member peer cannot open the private protocols or fetch any private CID.
- Block responses are verified (CID + signature + AEAD) before storage; a wrong-block-for-CID is rejected.
- The protocols carry only ciphertext; private CIDs are never announced to public routing.

**Testing:** Gated — member vs non-member protocol access; wrong-block/invalid-op rejection; no-public-announcement assertion.

**Dependencies:** WS-S.4.1, WS-S.6.3.

---

### WS-S.4.4 Public-gateway rejection guard
**ID:** WS-S.4.4 | **Ref:** PRIVATE_SPEC §9.5

**Status:** SHIPPED (the public-only guard is now wired to the Gate-19 publisher): `assertPublicGatewayEligible` (`@licio/lcap-p2p`) refuses any non-public / encrypted / private-room block, and `apps/api/src/lcap/publisher.ts` (`LcapPublicPublisher`) runs it ahead of every publish/republish; the `check:no-private-cid-egress` static gate covers the private trees.

**Description:** Add a render-path guard (and CI check) that REJECTS any private-room render path attempting to construct a public-gateway URL or perform a public DHT/delegated/IPNI/Bitswap lookup for a private CID. `check:no-private-cid-egress` statically scans the private-p2p trees for `ipfs.io`/public-gateway/public-routing patterns.

**Acceptance criteria:**
- Constructing a public-gateway URL for a private CID throws and is unreachable in any private render path.
- The static gate fails on any public-gateway/public-routing reference in the private trees.
- The guard runs at runtime AND in CI.

**Testing:** Unit — gateway-URL construction throws. CI — `check:no-private-cid-egress` positive/negative fixtures.

**Dependencies:** WS-S.4.2.

---

## WS-S.5 Operation log and deterministic reducer

### WS-S.5.1 Membership / role / capability ops + epoch enforcement
**ID:** WS-S.5.1 | **Ref:** PRIVATE_SPEC §11.3, §12, §13.2

**Description:** Implement the membership/authority ops — `member.add`/`member.remove`/`device.remove`/`role.grant`/`role.revoke`/`member.invite.create` — and the capability model (`read|post|invite|moderate|summarize|admin|rotate_keys|recover`) with the suggested role→capability mapping. Each op is signed and authorized by room capability state, not platform roles (§11.4). Add/remove drive MLS commits (WS-S.3.1a) and epoch rotation; the manifest's `membership_change` policy (`admin|threshold`) gates who may commit.

**Acceptance criteria:**
- Every membership/role op is capability-checked; no platform role can authorize one.
- Add/remove produce an MLS commit + new epoch + new manifest commitment + rotated topics/blind-ids.
- Threshold rooms require the configured M distinct admin authorizations (WS-S.3.6c).

**Testing:** Unit — capability gate per op; epoch-rotation-on-membership-change; threshold enforcement.

**Dependencies:** WS-S.2.3, WS-S.3.1a.

---

### WS-S.5.2 Content ops (story / thread / contribution / summary / attachment)
**ID:** WS-S.5.2 | **Ref:** PRIVATE_SPEC §13.3, §13.4, §13.5, §13.6

**Description:** Implement the content ops mirroring Licio's taxonomy locally: `story.create`/`story.edit`/`story.tombstone` (eight submission types incl. `image_post`/`video_post`; local canonical-URL normalization — never the server normalizer/safety service); `thread.state` (conversation/safety states, room-local, not platform decisions); `contribution.create`/`edit`/`tombstone` (eleven types with typed body caps, citations, parent validation, depth cap, lens-in-room, `client_draft_id` dedup); `summary.create`; `attachment.add`. All validated on decrypted state against the WS-S.2.3 schemas.

**Acceptance criteria:**
- Content ops enforce the same typed rules as shipped WS-G/WS-Q, locally; private link normalization is local-only.
- Room-local thread/safety states are clearly NOT platform moderation decisions in the model and UI.
- `client_draft_id` provides idempotent per-device dedup.

**Testing:** Unit — per-op-type validation parity with WS-G; local-normalization (no server call); draft dedup.

**Dependencies:** WS-S.5.1.

---

### WS-S.5.3a Op validation stage 1 — decode + crypto open (steps 1-5)
**ID:** WS-S.5.3a | **Ref:** PRIVATE_SPEC §14.2 (1-5)

**Description:** Implement the cryptographic front of the §14.2 pipeline in `packages/private-p2p/src/reducer/validate-op.ts`: (1) the op's CID is present in the local blockstore; (2) the envelope decodes under the private CIDv1 profile (WS-S.4.2); (3) the envelope signature verifies (WS-S.3.5) over the canonical bytes + public metadata; (4) the AEAD **opens** under an authorized epoch key — unwrap the object key (WS-S.3.3b) then open the body (WS-S.3.3a), reconstructing both AADs from authenticated metadata; (5) the decrypted plaintext schema validates strictly (WS-S.2.3). Any failure → quarantine with a typed reason; nothing past a failed step is trusted. This stage needs no membership/sequence state, so it runs on any fetched block.

**Acceptance criteria:**
- A wrong signature, an AAD mismatch, a wrong-epoch key, or a schema violation each quarantines with the exact reason — never a silent accept.
- The AEAD opens only when both reconstructed AADs byte-match; a tampered public field breaks the open.
- Stage 1 is pure over (block bytes, local epoch keys); it performs no DAG mutation.

**Testing:** Unit — steps 1-5 accept/reject matrix; AAD-tamper and wrong-epoch rejection; quarantine-reason coverage.

**Dependencies:** WS-S.5.2, WS-S.3.3a, WS-S.3.3b, WS-S.3.5, WS-S.4.2.

---

### WS-S.5.3b Op validation stage 2 — authority, epoch, and sequence (steps 6-11)
**ID:** WS-S.5.3b | **Ref:** PRIVATE_SPEC §14.2 (6-11), §10.9

**Description:** Implement the authority stage over the decrypted op: (6) `room_id` matches the room; (7) the epoch is valid for the op type; (8) the author device **existed and was not removed at the op epoch** (consults the membership log up to that epoch — a post-removal op fails); (9) the author sequence number is monotonic per device (a gap or replay fails); (10) parents are present or queued as missing dependencies; (11) the capability check passes for the op type (read/post/invite/moderate/admin/rotate/recover per WS-S.5.1, never a platform role). Each failure quarantines with its reason; missing parents queue and resolve on arrival.

**Acceptance criteria:**
- An op from a device removed at/before the op epoch is rejected; a non-monotonic/replayed author sequence is rejected.
- A capability-insufficient op (e.g. a `member`-role moderation op) is rejected; no platform role can satisfy the check.
- Missing parents queue as dependencies and re-enter validation when the parent arrives.

**Testing:** Unit — removed-device-at-epoch, sequence-replay, capability-insufficiency rejection; missing-parent queue/resolve.

**Dependencies:** WS-S.5.3a, WS-S.5.1.

---

### WS-S.5.3c Op validation stage 3 — semantic checks + DAG insertion
**ID:** WS-S.5.3c | **Ref:** PRIVATE_SPEC §14.2 (12-13)

**Description:** Implement the semantic stage and the accept/quarantine commit: (12) type-specific semantic validation (the WS-G-parity rules — typed body caps, citations for evidence/corrections, answer→question parent, depth cap, lens-in-room, `client_draft_id` dedup); (13) insert the op into the **accepted DAG** or quarantine it with a reason. Quarantined ops MUST NOT render; the accepted DAG is the reducer's (WS-S.5.4a/b) input. This stage is the single place an op becomes "accepted," so the "quarantined never renders" invariant is enforced here.

**Acceptance criteria:**
- A semantically-invalid op (missing required citation, wrong parent type, over-depth) is quarantined; a valid op enters the accepted DAG exactly once.
- Quarantined/unsupported ops are never returned to the reducer or rendered.
- Insertion is idempotent per op CID; re-validating an accepted op is a no-op.

**Testing:** Unit — semantic-rule matrix (WS-G parity); accepted-DAG idempotency; quarantine-never-renders property.

**Dependencies:** WS-S.5.3b.

---

### WS-S.5.4a Lamport validation + canonical total order
**ID:** WS-S.5.4a | **Ref:** PRIVATE_SPEC §14.3.1, §14.3.2

**Description:** Implement `lamport` handling and the canonical ordering in `packages/private-p2p/src/reducer/order.ts`: `lamport` is a non-negative integer serialized as a **decimal string** (exact beyond 2^53); on creation `lamport(op) = 1 + max(parent lamports ∪ local_lamport)`; validation REQUIRES `lamport(op)` strictly greater than every parent's (else the op is rejected upstream in WS-S.5.3b's parent check), making the Lamport order a linear extension of causality. `totalOrder(acceptedOps)` sorts ascending by the tuple `(lamport as big integer, created_at_bucket, author_device_id, op_id)` — because `lamport(child) > lamport(parent)` always holds, this single sort respects every causal edge and the remaining components only break concurrent ties, each fully determined by op content.

**Acceptance criteria:**
- An op with `lamport ≤` any parent is rejected; the comparator parses the decimal string as a big integer (no 2^53 loss).
- `totalOrder` is a linear extension of the causal DAG for every input; concurrent ties break deterministically by `(bucket, device, op_id)`.
- The order is identical across devices for the same accepted set.

**Testing:** Unit/property — lamport-monotonicity; causal-extension property; big-integer comparator above 2^53; tie-break determinism.

**Dependencies:** WS-S.5.3c, WS-S.2.2.

---

### WS-S.5.4b Deterministic fold + cross-device convergence
**ID:** WS-S.5.4b | **Ref:** PRIVATE_SPEC §14.3.2, §14.3.3

**Description:** Implement the pure fold `reduceRoom(orderedOps, policy, settings)` in `packages/private-p2p/src/reducer/reduce-room.ts`: fold the WS-S.5.4a-ordered ops through the per-type transition functions, producing room/story-list/thread/contribution-tree/member-capability/overlay/replication state. The fold MUST NOT read wall-clock, network arrival order, map/object iteration order, or floating point; "latest valid author edit wins" (WS-S.5.5) is decided by total-order position, not `created_at`. Canonical encoding (WS-S.2.2) governs every hashed/compared structure so equal logical state yields equal bytes. Two devices with the same accepted set produce byte-identical state.

**Acceptance criteria:**
- The fold is a pure function of (ordered ops, policy, settings); no nondeterministic input is read.
- Shuffled op-delivery orders yield byte-identical reducer state (property test over generated DAGs).
- LWW and tombstone effects follow total-order position, never timestamps.

**Testing:** Unit/property — shuffled-delivery byte-identical state; purity (no clock/iteration-order dependence); LWW-by-order.

**Dependencies:** WS-S.5.4a.

---

### WS-S.5.5 Conflict policy
**ID:** WS-S.5.5 | **Ref:** PRIVATE_SPEC §14.4

**Description:** Implement the §14.4 conflict table: two same-author story edits → latest valid author edit wins (history retained); concurrent unauthorized edits → rejected; moderator tombstone vs author edit → tombstone hides display, history retained encrypted; member removed while posting → post-removal-epoch ops rejected; same `client_draft_id` twice → idempotent dedup; missing parent → queue, don't render; invalid/tombstoned parent → tombstone policy / reject child unless orphan display allowed; unknown future op schema → store encrypted block, don't render, show "unsupported room update".

**Acceptance criteria:**
- Each conflict class resolves per the table; encrypted history is always retained.
- A post-removal-epoch op is rejected; an unknown-schema op stores but never renders.
- Resolution is a function of the deterministic order (WS-S.5.4a), not timestamps.

**Testing:** Unit — conflict-class matrix; history retention; unknown-schema non-render.

**Dependencies:** WS-S.5.4b.

---

### WS-S.5.6 Snapshots
**ID:** WS-S.5.6 | **Ref:** PRIVATE_SPEC §14.5, §25.6

**Description:** Implement `snapshot.commit` (snapshot id, includes-ops-up-to heads, state Merkle root, snapshot body CID, author) as an optimization hint — trusted only if signed by an authorized role AND verified against accepted ops; clients MAY prune old decrypted derived state but retain encrypted op history unless room policy + enough members agree to compaction. Snapshot cadence: every ~1,000 accepted ops or 7 days, after large import, after membership churn, plus a manual "optimize room storage" action.

**Acceptance criteria:**
- A snapshot is used only after role-signature + accepted-ops verification; it is never authority on its own.
- Encrypted op history is retained by default; compaction requires policy + member agreement.
- The cadence triggers fire and bound replay cost.

**Testing:** Unit — snapshot verify-before-use; retain-history default; cadence triggers.

**Dependencies:** WS-S.5.4b.

---

### WS-S.5.7 Local moderation overlays
**ID:** WS-S.5.7 | **Ref:** PRIVATE_SPEC §14.6, §19.1, §19.2

**Description:** Implement room-local moderator ops (contribution tombstone, thread restriction, member warning, member removal, media-hide recommendation, room-rule update, summary/steward note) — these are private-room operations, NOT platform moderation decisions — and per-member local-only overlays (`hidden_members`/`hidden_contributions`/`muted_threads`/`blocked_media`) that are not synced unless the user explicitly exports/imports their preferences.

**Acceptance criteria:**
- Room-local moderation ops are signed, capability-gated, and clearly distinguished from platform moderation.
- Local overlays stay device-local by default; sync only on explicit user export/import.
- A member can always leave, delete local data, hide/mute/block locally, and disable media auto-fetch.

**Testing:** Unit — moderation-op capability gate; overlay locality (no sync by default).

**Dependencies:** WS-S.5.2.

---

### WS-S.5.8 Local-only encrypted search
**ID:** WS-S.5.8 | **Ref:** PRIVATE_SPEC §13.7, §18.1, §25.7

**Description:** Implement local-only search over decrypted content in a worker: build incremental index shards (`title|body|citation|attachment_alt`), encrypt shards at rest (`PrivateLocalSearchShardPlainV1`), rebuild on schema upgrade or snapshot-verification failure. Server full-text/embeddings/query-logs/suggestions are FORBIDDEN (§18.1). Cross-member search-index sync is not required; same-member cross-device shard sync MAY be supported but must not leak metadata.

**Acceptance criteria:**
- Search runs entirely locally over decrypted content; index shards are encrypted at rest.
- No server search/index/embedding/query path is reachable from a private room.
- Local sorting (unread/recent/pinned/thread-state/filters) is explainable and creates no global distribution signal (§18.2).

**Testing:** Unit — local index build/query; encrypted-at-rest assertion; no-server-search assertion.

**Dependencies:** WS-S.5.4b.

---

## WS-S.6 P2P sync and rendezvous

### WS-S.6.1a Blind-id derivation + rendezvous records
**ID:** WS-S.6.1a | **Ref:** PRIVATE_SPEC §15.2, §15.3

**Description:** Implement blind-id derivation in `apps/web/src/private-p2p/sync/rendezvous-client.ts`: `room_blind_id = HMAC-SHA256(rendezvous_key, canonical(["room", epoch, time_bucket]))` and `peer_blind_id = HMAC-SHA256(rendezvous_key, canonical(["peer", device_id, epoch, time_bucket]))` — inputs canonical-encoded (WS-S.2.2), never `||`. `rendezvous_key` is the per-epoch key from the §10.2 schedule (WS-S.3.2). Build the `BlindRendezvousRecord` (room_blind_id, peer_blind_id, `encrypted_announcement` sealed under `rendezvous_key`, `expires_at`) with a short TTL (5-30 min), and the four discovery modes (local mDNS explicit, Licio blind rendezvous, member rendezvous, manual). The blind ids and announcement are the only things the server ever sees for an unlisted/detached room.

**Acceptance criteria:**
- Blind-id derivation is deterministic for `(rendezvous_key, epoch, time_bucket)` and uses canonical encoding, never `||`.
- The announcement is sealed under `rendezvous_key`; the server stores only blind ids + ciphertext + TTL.
- TTL is short; expired records are not returned (enforced with WS-S.6.6).

**Testing:** Unit — derivation determinism; canonical-input assertion; announcement seal/open; TTL handling.

**Dependencies:** WS-S.3.2.

---

### WS-S.6.1b Rendezvous authorization model + metadata-leakage mitigations
**ID:** WS-S.6.1b | **Ref:** PRIVATE_SPEC §15.3.1, §15.3.2, §5.4

**Description:** Implement and test the §15.3.1 authorization property — knowledge of `rendezvous_key` **is** the rendezvous capability: only a current-epoch member can compute a room's `room_blind_id` to announce or poll; the server performs no ACL (it cannot map blind ids to rooms/accounts); a removed member loses the capability at the next epoch (rotation via WS-S.3.1b); polling an unknown blind id returns the same bounded opaque result whether or not records exist, so it is not a room-existence oracle for outsiders. Implement the §15.3.2 metadata mitigations and document their residual leakage: coarse `time_bucket`s + per-peer announcement jitter (blunt the "approximate concurrent size" inference a server could draw from distinct `peer_blind_id`s under one `room_blind_id`), optional cover/dummy traffic for high-risk rooms, and steering high-risk rooms to `member_rendezvous`/`manual` so Licio sees nothing.

**Acceptance criteria:**
- A non-member cannot derive a room's blind id; a removed member cannot after the next epoch; polling is not an existence oracle.
- The size-inference mitigation is implemented (bucket granularity + jitter configurable per room) and its residual leakage is documented honestly in the §5.4 metadata table.
- High-risk rooms can disable Licio blind rendezvous entirely in favor of member/manual discovery.

**Testing:** Unit/property — member-only derivation; removed-member-loses-access after rotation; no-existence-oracle; size-inference mitigation under a server-observer model.

**Dependencies:** WS-S.6.1a, WS-S.3.1b.

---

### WS-S.6.2 Encrypted WebRTC signaling + relay-only mode
**ID:** WS-S.6.2 | **Ref:** PRIVATE_SPEC §15.4

**Status:** SHIPPED, including **§15.4 ICE-restart recovery** for a long-lived connection. The sealed signaling channel (`establishDataChannel`) now OUTLIVES channel-open as a maintenance loop carrying renegotiation; a connection/ICE-state watcher (`installIceRestartWatcher` in `apps/web/src/private-p2p/connect-peer.ts`) debounces a `disconnected` blip / restarts immediately on `failed`, the OFFERER re-offers with `iceRestart` (calling `pc.restartIce()` when present) while the answerer renegotiates, the SAME data channel + the membership-proven §15.5 session key are preserved (no re-handshake), restarts are bounded per episode + reset on recovery, and on exhaustion the channel drops → `maintainConnection` re-dials. Covered by `ice-restart.test.ts` (deterministic state machine) + the real-Chromium `private-carrier.realwebrtc.spec.ts` (a real `restartIce()` + `iceRestart` re-offer keeps the channel alive). The relay-only IP suppression + opaque-signal routing remain as before.

**Description:** Implement WebRTC signaling where messages are E2E-encrypted before reaching the server (the server routes only opaque `EncryptedSignal` blobs: room/sender/recipient blind ids + ciphertext + expiry). Implement relay-only transport mode so members who do not want to reveal IP addresses to one another route through relays; ICE candidates (which reveal network info) are suppressed in relay-only mode. A long-lived connection recovers a transient path failure by §15.4 ICE-restart on the SAME `RTCPeerConnection` (preserving the membership-proven session key) before falling back to a full re-dial.

**Acceptance criteria:**
- Signaling payloads are E2E-encrypted; the server routes opaque blobs and cannot read SDP/ICE.
- Relay-only mode hides peer IPs from other members; direct mode is opt-in per room policy.
- Signaling is bound to room/epoch to prevent cross-room confusion.

**Testing:** Unit — signal encryption (server sees ciphertext only); relay-only IP suppression. Gated — two peers connect via encrypted signaling.

**Dependencies:** WS-S.6.1a.

---

### WS-S.6.3 Membership-proving handshake
**ID:** WS-S.6.3 | **Ref:** PRIVATE_SPEC §15.5

**Description:** Implement the private libp2p handshake: transport connect → exchange protocol version + ephemeral peer keys → each peer proves membership by signing a challenge with a room-valid device key → derive a pairwise session key from current epoch material + ephemeral ECDH → exchange encrypted head summaries → request missing blocks. The transcript MUST be bound to room-id commitment, epoch, protocol version, and peer ephemeral keys to prevent replay/cross-room confusion.

**Acceptance criteria:**
- A peer that cannot sign a challenge with a current-epoch device key is rejected before any block exchange.
- The pairwise session key is fresh per connection (ephemeral ECDH) and epoch-bound.
- The transcript binding defeats replay and cross-room confusion.

**Testing:** Unit/gated — member handshake succeeds, non-member fails; transcript-binding replay rejection.

**Dependencies:** WS-S.3.5, WS-S.6.1a.

---

### WS-S.6.4 Head announcement + missing-block protocol + sync priority
**ID:** WS-S.6.4 | **Ref:** PRIVATE_SPEC §15.6, §15.7, §15.8

**Description:** Implement the encrypted `HeadAnnouncementPlainV1` (known heads, latest snapshot, op-count bucket, want-ranges) on the pairwise channel (never to the main server); the `BlockRequestV1`/`BlockResponseV1` protocol (priority `manifest|ops|thread|media|snapshot`, max-bytes, refuse-large/backoff) with every returned block verified by CID+signature+AEAD; and the §15.8 fetch order (manifest → membership/capabilities → heads/ancestors → thread/story index → visible text → summaries → media manifests → media chunks on demand → archives/snapshots).

**Acceptance criteria:**
- Head announcements are encrypted and peer-only; the main server never sees heads.
- Block responses are verified before use; peers may refuse/throttle large requests.
- The fetch order delivers a usable thread list before media; media is lazy.

**Testing:** Unit — head-exchange + missing-ancestor fetch; verify-before-use; fetch-order priority.

**Dependencies:** WS-S.6.3, WS-S.5.3a.

---

### WS-S.6.5 Offline CAR exchange (+ optional LCAP bundle)
**ID:** WS-S.6.5 | **Ref:** PRIVATE_SPEC §15.9

**Description:** Implement encrypted CAR export/import (export selected encrypted blocks → CAR → share via USB/AirDrop/manual → import → verify → reduce). The container MAY be a standard IPLD CAR or the WS-R LCAP `.licio-bundle` pack (streaming parse under caps, dependency-first ordering, range resume, quarantine-before-render). CAR exports contain **ciphertext only**; the importer re-runs the full WS-S.5.3a–c validation before any block renders. Export UI distinguishes encrypted member backup / decrypted personal archive / voluntary report package.

**Acceptance criteria:**
- CAR/bundle exports are ciphertext-only; import re-validates every block (no container-conferred trust).
- The three export kinds are clearly distinguished; decrypted export carries a strong warning.
- The optional LCAP-bundle path interoperates with WS-R's reader and is gated to ciphertext for private rooms.

**Testing:** Unit — CAR/bundle export/import round-trip; ciphertext-only assertion; re-validation-on-import.

**Dependencies:** WS-S.5.3a (optional: WS-R.4.2).

---

### WS-S.6.6 Server rendezvous endpoints + abuse controls
**ID:** WS-S.6.6 | **Ref:** PRIVATE_SPEC §21.5, §27.2

**Description:** Implement `POST /v1/private-rendezvous/announce|poll|signal` with opaque payloads only (blind ids + ciphertext + short TTL); limits: short TTL, bounded payload size, blind-ID rate limiting, aggregate-only abuse metrics (no room identity), no content inspection, no long-term storage. Rate limiting keys on a non-reversible account reference or account-scoped blind token, never an IP (Section 19.1). Optional proof-of-work/account-scoped tokens if abuse warrants.

**Acceptance criteria:**
- Endpoints accept only opaque blobs; the server cannot map a record to room/content/members/CIDs for unlisted/detached rooms.
- TTL/size/rate limits are enforced; metrics are aggregate-only and unlinkable to room identity.
- Rate limiting reads no client IP; records auto-expire and are deleted.

**Testing:** Gated integration — opaque-only enforcement; TTL/size/rate limits; aggregate-only-metrics assertion; no-IP-read assertion.

**Dependencies:** WS-S.1.2, WS-S.6.1a.

---

## WS-S.7 Private room UI

### WS-S.7.1 Creation wizard + mandatory disclosures
**ID:** WS-S.7.1 | **Ref:** PRIVATE_SPEC §12.1, §20.2; Appendix A

**Description:** Implement `PrivateRoomCreate.tsx` running the §12.1 / Appendix A sequence: show + require the §6 disclosure and the five acknowledgments (WS-S.0.3); verify the private-mode bundle signature/hash (WS-S.10.2a) BEFORE generating keys; generate device signing + HPKE keys; create the MLS group; derive epoch-0 secrets; create the encrypted manifest + first membership op; store encrypted blocks locally; optionally create the server stub (no content/CIDs/heads); start blind rendezvous if policy allows; render from local reducer state. Creation fields: name, directory mode (unlisted default), transport mode (relay-preferred default), replication target, allow-blind-push (off default), require-admin-approval (on default), recovery-kit (now/later).

**Acceptance criteria:**
- Creation is blocked until acknowledgments are checked AND the bundle is verified; the server never receives manifest plaintext/member list/op heads.
- Defaults match §20.2 (unlisted, relay-preferred, blind-push off, admin-approval on).
- The room opens from local reducer state immediately after local creation.

**Testing:** E2E (Playwright + axe) — full creation flow incl. acknowledgment gating + bundle-verify gate; no-server-content request assertion.

**Dependencies:** WS-S.5.4b, WS-S.3.6b, WS-S.10.2b.

---

### WS-S.7.2 Room shell + header status + trust indicators
**ID:** WS-S.7.2 | **Ref:** PRIVATE_SPEC §19.5, §20.3

**Description:** Implement `PrivateRoomShell.tsx` with the compact §20.3 header status ("Private P2P · Unlisted · Relay preferred · 3/3 replicas · Backup created · Safety number verified") expandable to detail, and the §19.5 trust indicators (verified/unverified member devices, recent membership changes, room-safety-number-changed warning, update-channel trust state, replication/backup health, transport mode, blind-push state). The shell renders from local decrypted reducer state, never from `/v1/stories|threads|contributions`.

**Acceptance criteria:**
- The header shows the honest compact status; all §19.5 indicators are present and expandable.
- The shell never calls server content endpoints for a p2p room; it reads local reducer state.
- A changed safety number surfaces a clear warning.

**Testing:** Unit — status/indicator rendering from reducer state. E2E (axe) — shell accessibility + no server-content fetch.

**Dependencies:** WS-S.5.4b, WS-S.7.4.

---

### WS-S.7.3 Composer + thread view (local reducer state)
**ID:** WS-S.7.3 | **Ref:** PRIVATE_SPEC §13, §18.2; WS-G composer

**Description:** Implement `PrivateComposer.tsx` and `PrivateThreadView.tsx` reusing the WS-G 11-mode structured-composer UX but producing **signed encrypted ops** into the local log (not server contributions). Thread view renders contribution trees from the reducer with local-only sorting (unread/recent/pinned/thread-state/filters, §18.2) — explainable, creating no global distribution signal. UGC bodies pass through the existing `licio-ugc` DOMPurify/Trusted Types sink.

**Acceptance criteria:**
- Posting creates a signed encrypted op locally; nothing hits server content endpoints.
- Thread rendering is deterministic from the reducer; local sorting is explainable and non-global.
- UGC is sanitized through the single sanctioned sink (no new `dangerouslySetInnerHTML`).

**Testing:** Unit — op creation from composer; local-sort determinism. E2E (axe) — compose/post/reply + UGC sanitization.

**Dependencies:** WS-S.5.2, WS-S.7.2.

---

### WS-S.7.4 Invite + member panels + safety-number verification
**ID:** WS-S.7.4 | **Ref:** PRIVATE_SPEC §11.5, §12.2, §20.4; Appendix B

**Description:** Implement `PrivateInvitePanel.tsx` (role granted, expiration, max uses, approval requirement, paste-warning, copy/QR/export, revoke) and `PrivateMemberPanel.tsx` with §11.5 safety-number verification (`room_safety_number = HASH(room_public_key || mls_epoch_authenticator || sorted(active_device_public_keys) || manifest_policy_hash)`) comparable via QR/short-authentication-string out of band. Drive the Appendix B invite sequence (sealed-fragment invite → join request → MLS Add → Welcome → sync).

**Acceptance criteria:**
- Invites show role/expiry/uses/approval + a not-in-public warning; revoke works; the secret stays in the URL fragment.
- Safety-number compare (QR/SAS) shows verified/changed/unverified; a changed number warns prominently.
- The full invite→join→Add→Welcome→verify flow completes across two clients.

**Testing:** E2E (Playwright + axe) — invite/join/verify across two contexts; revoke; safety-number-changed warning.

**Dependencies:** WS-S.3.4, WS-S.5.1.

---

### WS-S.7.5 Replication/backup health + update-trust UX
**ID:** WS-S.7.5 | **Ref:** PRIVATE_SPEC §16.3, §16.4, §20.6

**Description:** Implement `PrivateReplicationHealth.tsx` + `PrivateBackupPanel.tsx` showing the §16.4 replication health ("2/3 recommended copies online recently", last full sync, missing blocks by class, backup state, transport mode) against the §16.3 replication targets, without exposing exact peer identities unless the user opens a detail panel. Implement the §20.6 update-trust lock UX: if the private-mode bundle is unsigned / not in the transparency log / hash-mismatched, private rooms lock with the exact §20.6 message and keys are NOT unlocked.

**Acceptance criteria:**
- Replication/backup health is honest and per-class; peer identities are hidden by default.
- An unverified bundle locks private rooms with the §20.6 copy before any key unlock.
- Backup-not-created and low-replica states prompt clearly.

**Testing:** Unit — health rendering vs targets; lock-on-unverified-bundle. E2E (axe) — health panel + lock screen.

**Dependencies:** WS-S.7.2, WS-S.10.2b.

---

## WS-S.8 Media and attachments

### WS-S.8.1a Local media validation + metadata strip + accessibility gate
**ID:** WS-S.8.1a | **Ref:** PRIVATE_SPEC §17.1, §17.2

**Description:** Implement the front of the local-only media pipeline in `apps/web/src/private-p2p/media/validate.ts` (a Web Worker; **no** server scan gate or object-storage endpoint is touched): file selection → byte-level MIME sniff + size/duration caps → local metadata stripping (reuse the shipped WS-G byte-level EXIF stripper and the WS-Q video-container neutralizer) → optional local thumbnail/poster generation → the required-accessibility gate (alt text for images, captions/description for video, enforced before the item can be sent). If a type cannot be safely stripped, surface the §17.2 unstrippable-type warning and block send. Output is a validated, metadata-free plaintext byte stream + accessibility metadata, ready for WS-S.8.1b; this card performs no encryption.

**Acceptance criteria:**
- Sniff + size/duration caps + metadata strip run entirely locally; a static assertion proves no server upload/scan endpoint is reachable from this module.
- The accessibility gate blocks send until alt text / captions are present; an unstrippable type shows the §17.2 warning and cannot be sent.
- The WS-G EXIF stripper and WS-Q video neutralizer are reused verbatim (no second metadata-stripping implementation).

**Testing:** Unit — sniff/strip/thumbnail; accessibility-gate enforcement; unstrippable-type warning; no-server-call assertion.

**Dependencies:** WS-S.5.2, WS-G EXIF stripper + WS-Q video neutralizer (shipped).

---

### WS-S.8.1b Local chunk + per-chunk encrypt + encrypted attachment manifest
**ID:** WS-S.8.1b | **Ref:** PRIVATE_SPEC §17.1, §13.6

**Description:** Implement the encrypting tail of the media pipeline in `apps/web/src/private-p2p/media/encrypt-manifest.ts`: take WS-S.8.1a's validated plaintext stream → fixed-size chunk → encrypt **per chunk** under a fresh object key + nonce (WS-S.3.3a) → content-address each ciphertext chunk (CIDv1 over ciphertext, WS-S.4.2) → assemble the encrypted `PrivateAttachmentManifestPlainV1` (encrypted-chunk CIDs in order, per-chunk plaintext+ciphertext SHA-256, total plaintext size, a `metadata_stripped` flag, and a **padded `size_class`** that hides exact small sizes) → hand the chunks + manifest to the P2P block sync (WS-S.6.4). The manifest itself is an op-referenced object so it rides the reducer like any other content.

**Acceptance criteria:**
- Each chunk is encrypted under a unique key+nonce and content-addressed over **ciphertext**; the manifest lists encrypted-chunk CIDs + plaintext/ciphertext hashes + `metadata_stripped` + a padded `size_class`.
- Padding hides exact small sizes (a 3 KB and a 7 KB image fall in the same advertised class); the manifest round-trips into the reducer state.
- No plaintext chunk or plaintext CID is ever produced or stored.

**Testing:** Unit — chunk/encrypt/manifest assembly; per-chunk nonce-uniqueness; size-class padding; ciphertext-only CID assertion; manifest reducer round-trip.

**Dependencies:** WS-S.8.1a, WS-S.3.3a, WS-S.4.2.

---

### WS-S.8.2 Encrypted streaming (range chunks, MediaSource)
**ID:** WS-S.8.2 | **Ref:** PRIVATE_SPEC §17.4, §25.8

**Description:** Implement lazy encrypted streaming: media manifest → chunk index → fetch encrypted chunks lazily → decrypt locally → stream to a media element via MediaSource where supported, prefetching only the next few chunks (never auto-fetching full large videos). Support pause/resume. Deduplicate identical encrypted chunks only within the same object (never convergent cross-user dedup, §25.8).

**Acceptance criteria:**
- Large media streams chunk-by-chunk with bounded prefetch; full videos are not auto-fetched.
- Decryption is local; pause/resume works; no autoplay.
- Cross-object/cross-user convergent dedup is not used (no equality leakage).

**Testing:** Unit — lazy chunk fetch + bounded prefetch; no-autoplay; no-convergent-dedup assertion. E2E — stream play/pause/resume.

**Dependencies:** WS-S.8.1b.

---

### WS-S.8.3 Local media safety controls + accessibility
**ID:** WS-S.8.3 | **Ref:** PRIVATE_SPEC §17.3, §17.5

**Description:** Implement the §17.3 local controls (never auto-download large media; blur unknown media by default; hide media from unverified members; block file types locally; per-member media mute; report/export package for selected media; optional client-side perceptual-hash warning against the user's own blocked library — no server lookup) and the §17.5 accessibility (required alt text for image posts; captions for video via encrypted caption attachments/inline text — alt/captions are private content, encrypted like everything else).

**Acceptance criteria:**
- All local media controls function without any server scan/lookup; the perceptual-hash check is local-only.
- Image posts require alt text; video supports captions; both are encrypted.
- Unverified-member media is hidden/blurred per the user's settings.

**Testing:** Unit — each control; alt-required/caption-support; local-only perceptual hash. E2E (axe) — media a11y.

**Dependencies:** WS-S.8.1b.

---

## WS-S.9 Migration from existing server-private rooms

### WS-S.9.1 Restricted-room disclosure + rename (Phase 1)
**ID:** WS-S.9.1 | **Ref:** PRIVATE_SPEC §24.1, §24.2 (Phase 1)

**Description:** Implement Phase 1: rename existing server "private"/restricted rooms in UI to "Members-only server room" with the explanation "visible only to members in the app, but hosted on Licio servers." Establish the core migration rule: existing server-hosted rooms cannot be silently upgraded into real private rooms — their history already existed on the server; migration creates a NEW P2P room and optionally imports history through a member's client.

**Acceptance criteria:**
- All restricted rooms are relabelled and explained; none implies E2EE.
- The "no silent upgrade" rule is enforced — there is no in-place "make private" toggle that pretends to retroactively protect history.

**Testing:** Unit — relabel copy + no-in-place-upgrade guard. E2E (axe) — restricted-room info surface.

**Dependencies:** WS-S.0.2.

---

### WS-S.9.2a Migration wizard shell + P2P destination creation + member re-invite (Phase 2)
**ID:** WS-S.9.2a | **Ref:** PRIVATE_SPEC §24.2 (Phase 2), §24.3

**Status:** SHIPPED: the 6-phase `MigrationWizard` (`apps/web/src/components/migration/`, the `/private/migrate` route) creates a brand-new P2P destination (`PrivateRoomSession.create`) — never an in-place upgrade — re-invites members via `InvitePanel`, and renders the §24.3 "improves privacy from this point forward" disclosure + ack before any destination is created.

**Description:** Implement the migration wizard shell that creates the **new** P2P destination room — never an in-place upgrade of the server room: generate room keys + initial MLS group locally, write only an optional directory stub server-side (if listed/unlisted), and re-invite members through P2P invites (WS-S.3.4) so that **old server subscriptions confer no P2P access**. Surface the §24.3 framing up front ("this improves privacy from this point forward; it cannot make past server access impossible"). This card creates the destination and membership; the content import modes are WS-S.9.2b.

**Acceptance criteria:**
- The wizard creates a brand-new P2P room (local keys/MLS group) + at most a directory stub; the original server room is untouched at this stage.
- Members are re-invited via P2P invites; a former server subscriber with no P2P invite gets **no** access.
- The §24.3 "improves privacy from this point forward" disclosure renders before any destination is created.

**Testing:** Unit — destination-creation + stub-optionality; re-invite-not-subscription. E2E — create-destination + re-invite flow.

**Dependencies:** WS-S.7.1, WS-S.7.4.

---

### WS-S.9.2b Import modes (Fresh / Selected / Full / Redacted) + per-mode leakage disclosure (Phases 3-4)
**ID:** WS-S.9.2b | **Ref:** PRIVATE_SPEC §24.2 (Phases 3-4), §24.3

**Status:** SHIPPED: `apps/web/src/private-p2p/migrate.ts` (`reauthorIntoPrivateRoom`) runs the §24.2 `planMigration` (Fresh/Selected/Full/Redacted) over the server export and re-authors each planned item into the destination session via `postStory`/`postComment` (which ENCRYPT as they author — no server-readable copy); the per-mode honest leakage disclosure is surfaced from the SSOT in the wizard's import-mode phase.

**Description:** Implement the four §24.2 content-import modes that copy server-hosted history into the WS-S.9.2a destination as new encrypted ops: **Fresh start** (no import), **Selected import** (chosen threads/items), **Full import** (all readable history), **Redacted import** (import with author-chosen removals). Each mode shows the §24.3 honest disclosure that imported history **was previously server-hosted** and that importing it does not retroactively make that past access impossible. Imported items become ordinary encrypted content ops in the new room (re-authored under the importer's device key, with provenance noted), never a server-readable copy.

**Acceptance criteria:**
- All four modes work; each imported item becomes a normal encrypted op in the destination (no server-readable copy is created by import).
- Every mode shows the "imported history was server-hosted / cannot un-share the past" disclosure before importing.
- Redacted import omits author-chosen items; Selected import imports exactly the chosen set; Fresh start imports nothing.

**Testing:** Unit — per-mode import set + disclosure presence; no-server-copy assertion. E2E — selected-import end-to-end into the destination.

**Dependencies:** WS-S.9.2a.

---

### WS-S.9.3 Freeze + purge/minimize old server room (Phases 5-6)
**ID:** WS-S.9.3 | **Ref:** PRIVATE_SPEC §24.2 (Phases 5-6)

**Status:** SHIPPED: `apps/api/src/forum/migration-export.ts` `freezeRoomForMigration` (Phase 5 — a server-enforced read-only `frozen` flag, migration `0047`) + `purgeRoomForMigration` (Phase 6 — `purge`/`anonymize`), both steward-gated; purge is fail-closed gated on freeze-first (`409 room_not_frozen`) so the §8 disclosure stays honest, and never touches member-held P2P content. `POST /v1/rooms/:roomId/migration/{freeze,purge}` + the wizard's freeze/purge phases drive it.

**Description:** Implement Phase 5 (old server room becomes read-only with a banner pointing to the P2P replacement) and Phase 6 (where policy/law permit, purge or minimize old server data — stories, threads, contributions, uploads, search docs, ranking candidates, content events, review queues, derived summaries, caches), disclosing any retained legal/audit records as server-retained historical artifacts (not private P2P content).

**Acceptance criteria:**
- The old room freezes read-only with a clear pointer; no new server content is accepted.
- Purge/minimize removes the enumerated server artifacts where permitted; retained legal/audit records are disclosed as such.
- Purge is reversible-safe (idempotent, audited) and does not touch member-held P2P content.

**Testing:** Gated integration — freeze + purge across the enumerated tables; retained-record disclosure. E2E — frozen-room banner.

**Dependencies:** WS-S.9.2b.

---

## WS-S.10 Hardened trust and the update channel

### WS-S.10.1 Reproducible private-mode bundle + signed manifest
**ID:** WS-S.10.1 | **Ref:** PRIVATE_SPEC §1, §3.2; WS-O reproducible-build reuse

**Description:** Make the lazily code-split private-p2p chunk (WS-S.2.1) a **reproducible build** with a deterministic output hash, and produce a signed release manifest (maintainer signatures over the chunk hash) reusing the WS-O reproducible-build + provenance machinery (WS-O.3.1a deterministic build; WS-O.3.2b per-chunk in-toto attestation + append-only transparency log). This is the well-bounded artifact the transparency log and SW pinning attest. Tier 1 protects against passive server-storage compromise + ordinary administration; this card is the foundation for the Tier 2/3 update-channel protections.

**Acceptance criteria:**
- The private-mode chunk builds reproducibly to a stable hash across environments; the manifest is signed by the required maintainers.
- The artifact boundary is exactly the private chunk (not the whole app), keeping attestation tractable.
- The Tier 1 limitation (no defense against malicious web update) is documented honestly in-product.

**Testing:** CI — reproducible-build hash stability; manifest signature verification.

**Dependencies:** WS-S.2.1.

---

### WS-S.10.2a Transparency-log verify-before-unlock primitive
**ID:** WS-S.10.2a | **Ref:** PRIVATE_SPEC §20.6, §22.4

**Status:** SHIPPED as the PURE, fail-closed verify-before-unlock core (`packages/shared/src/update/`, `verifyUpdateManifest`/`decideUpdateActivation`): a `trusted` verdict requires the manifest be maintainer-Ed25519-SIGNED over a body whose `bundle_digest` equals the SHA-256 of the RUNNING bytes, PRESENT in the append-only transparency log via an RFC 9162 inclusion proof against a log-signed checkpoint, and NOT stale; every other case (unsigned / untrusted signer / digest mismatch / bad checkpoint / proof miss / read failure) is a typed UNTRUSTED verdict — no soft pass, no "unknown ⇒ allow". The verdict owns no key-unlock or SW side-effect (consumed by 10.2b).

**Description:** Implement the code-transparency check that decides whether the running private chunk is trustworthy: a fail-closed lookup + signature verification of the running private-mode bundle hash against the WS-O.3.2b transparency log, via the WS-O.3.2e runtime-verification primitive, exposed as `assertPrivateBundleTrusted(): TrustedBundleVerdict`. The verdict gates room-key unlock (consumed by WS-S.10.2b). Unsigned, not-in-log, and hash-mismatched all return an explicit untrusted verdict (never a soft pass); a log/network read failure is **untrusted** (fail-closed). This card owns the verdict only — no SW or UI side-effects.

**Acceptance criteria:**
- The verdict is `trusted` only when the running chunk hash is signed AND present in the transparency log AND signature-valid; every other case (incl. unreadable log) is `untrusted`.
- The primitive performs no key unlock and no SW mutation itself; it is a pure verdict consumed by WS-S.10.2b.
- The verdict reuses the WS-O.3.2e/3.2b primitives verbatim (no second transparency-verification implementation).

**Testing:** Unit — trusted/unsigned/not-in-log/mismatch/unreadable verdict matrix; fail-closed on read error.

**Dependencies:** WS-S.10.1, WS-O.3.2e (runtime verification primitive), WS-O.3.2b (per-chunk attestation + transparency log).

---

### WS-S.10.2b SW update pinning + room-lock-on-unverified + post-incident rotation + CI gate
**ID:** WS-S.10.2b | **Ref:** PRIVATE_SPEC §20.6, §27.5

**Status:** SHIPPED: `apps/web/src/update/` is the client gate (`assertPrivateBundleTrusted` hashes the running bundle, verifies, and LOCKS the rooms with the exact §20.6 copy on an untrusted verdict — keys stay sealed) + the SW pinning that refuses a silent takeover by an unverified bundle; `ensurePrivateBundleTrusted()` is wired into `PrivateRoomSession.{create,load}`/`loadPrivateRoomEngine` (engaged when a signer set is build-pinned). The new `check:update-channel` CI gate proves the verify-before-activate + lock-on-fail wiring stays present (the pre-existing `check:private-bundle-transparency` gate still covers the no-dynamic-remote-private-code pin).

**Description:** Enforce the WS-S.10.2a verdict end-to-end: the service worker **pins** the private chunk and refuses to silently load a dynamic remote private bundle (CSP / Trusted Types / no-dynamic-remote-code stay enforced); on an `untrusted` verdict, private rooms **LOCK before any key unlock** with the exact §20.6 message and keys stay sealed; after a verified-safe client recovers from an incident, trigger room-key rotation (§27.5). Add the `check:private-bundle-transparency` CI gate asserting the pin + lock path. This card owns the SW pinning, the lock UX hook (rendered by WS-S.7.5), and the rotation trigger.

**Acceptance criteria:**
- Room keys never unlock unless WS-S.10.2a returns `trusted`; an `untrusted` verdict locks private rooms (keys sealed) with the exact §20.6 copy.
- The SW cannot silently load dynamic remote private code (pinned chunk; CSP blocks inline/eval); `check:private-bundle-transparency` runs in CI.
- After a verified-safe recovery, room-key rotation (§27.5) is triggered.

**Testing:** Unit — lock-on-untrusted; pin-refuses-remote; rotation-trigger. E2E — unsigned/mismatched bundle locks the room; CSP blocks inline/eval (WS-S.11.4).

**Dependencies:** WS-S.10.2a.

---

### WS-S.10.3 Local key agent (Tier 3)
**ID:** WS-S.10.3 | **Ref:** PRIVATE_SPEC §10.8, §22.5, §30.3

**Description:** Specify and (scope-permitting) prototype the Tier 3 local key agent holding room keys **outside** the web origin, exposing `POST http://127.0.0.1:<random>/licio/private/{sign,decrypt-key,mls-commit,export-recovery}`. The agent authenticates the web origin, shows user approval for sensitive operations, and never exposes raw room keys to web JavaScript — the strongest defense against a malicious web update. v1-launch scope (full agent vs Tier 1/2 + documented limitation) is open question §30.3.

**Acceptance criteria:**
- The agent signs/decrypts/commits without ever returning raw keys to web JS; it authenticates the origin and prompts for sensitive ops.
- The web app degrades gracefully to Tier 1/2 when no agent is present.
- The v1 scope decision (agent vs documented Tier-1 limitation) is recorded in §30.3.

**Testing:** Unit/contract — agent API contract; no-raw-key-egress; origin auth. (Full E2E only if shipped in v1.)

**Dependencies:** WS-S.3.6a, WS-S.10.2a.

---

## WS-S.11 Audit, test plan, and launch

### WS-S.11.1 Unit + crypto-vector + fuzz suite
**ID:** WS-S.11.1 | **Ref:** PRIVATE_SPEC §26.1, §26.2

**Description:** Implement the §26.1/§26.2 suites: strict zod schema tests for every private type; canonical-encoding stability; KDF domain separation; nonce uniqueness; envelope encrypt/decrypt; signature verification; capability-validation matrix; reducer determinism; conflict resolution; snapshot verification; official HPKE + MLS vectors; differential canonical encodings; malformed-envelope/op fuzz; the "unauthorized ops never render" and "removed members cannot decrypt future epoch" properties.

**Acceptance criteria:**
- All listed unit/vector/property/fuzz tests pass; coverage meets the 80% gate for the workspace.
- Official HPKE and MLS vectors pass; nonce-uniqueness and removed-member-cannot-decrypt properties hold.

**Testing:** The suite itself (Vitest + property + fuzz).

**Dependencies:** WS-S.3.7, WS-S.5.5.

---

### WS-S.11.2 Network/privacy request-capture tests
**ID:** WS-S.11.2 | **Ref:** PRIVATE_SPEC §26.3

**Description:** Implement Playwright request-capture tests over the full flow (create room → invite → post story → comment → attach media → sync → remove member → create future content) asserting that NO outbound HTTP/WebSocket request contains a private title/body, private URL, private CID, op id, thread id, contribution id, member list, invite fragment, plaintext key, or exact room id for unlisted/detached rooms.

**Acceptance criteria:**
- Across the whole flow, no captured request carries any forbidden value; the assertion enumerates each.
- The test runs in CI (BFF-in-the-loop harness extension) and fails on any leak.

**Testing:** Playwright request-capture suite; CI wiring.

**Dependencies:** WS-S.7.4, WS-S.6.6, WS-S.8.1b.

---

### WS-S.11.3 Server DB no-content + P2P sync correctness tests
**ID:** WS-S.11.3 | **Ref:** PRIVATE_SPEC §26.4, §26.5; Appendix D

**Status:** SHIPPED (the audit suite): the no-server-content umbrella audit (`apps/api/src/__tests__/private-no-server-content.audit.test.ts` — Appendix D `assertNoP2PServerContent`, the endpoint 409/404/feed-409 rejections, + the gated §8.3-trigger leg), the rendezvous-privacy audit (`private-rendezvous.audit.test.ts` — opaque-only storage, `.strict()` identity-field rejection, the §8.2 allowlist, the TTL upper bound, transient signals; this run FIXED a latent `DrizzleRendezvousStore.poll` Date-bind bug — now `gt(expiresAt, new Date(nowMs))`), and the 3+-peer convergence matrix (`packages/private-p2p/.../multi-peer-convergence.test.ts` — star / chain-relay / concurrent-author / out-of-order+duplicate topologies, identical `roomStateCommitment`). A pinned known-answer SAS vector (`safety-number-vector.test.ts`) locks `computeSafetyNumber`.

**Description:** Implement the §26.4 DB assertions (after P2P activity: stories/threads/event-payload/search/ranking-candidates all 0 for the room — Appendix D `assertNoP2PServerContent`) and the §26.5 sync-correctness matrix (two peers online; offline edits on both → conflict merge; missing-parent fetch; media partial fetch; snapshot restore; CAR export/import; relay-only mode; rendezvous unavailable; malicious peer sends invalid op / wrong block for CID / replays old epoch op; removed peer attempts sync).

**Acceptance criteria:**
- The DB assertion proves zero private content rows after a full E2E run.
- Every sync-correctness scenario passes, including each malicious-peer case (rejected, not rendered) and removed-peer (cannot sync future).
- Conflict merges are deterministic and identical across the two peers.

**Testing:** Gated integration (Postgres) — Appendix D assertion; multi-peer sync simulation suite.

**Dependencies:** WS-S.1.5, WS-S.6.4, WS-S.5.5.

---

### WS-S.11.4 Update-channel tests
**ID:** WS-S.11.4 | **Ref:** PRIVATE_SPEC §26.6

**Status:** SHIPPED (the mandatory Tier-1/2 set): the WS-S.10 verify-before-unlock core's matrix (`packages/shared/src/update/verify.test.ts` — unsigned / mismatch / not-in-log / stale all LOCK; only a fully-trusted bundle activates) + the client gate + SW-pinning tests (`apps/web/src/update/{gate,sw-pinning}.test.ts`) + the structural `check:update-channel` CI gate. The conditional Tier-3 key-agent-refusal test remains gated on the §30.3 WS-S.10.3 in-scope decision.

**Description:** Implement the §26.6 update-channel tests. The **mandatory** set (required for every launch path, Tier 1/2/3) is: an unsigned private-mode bundle locks the room; a transparency-log mismatch locks the room; the service worker cannot silently load dynamic remote private code; CSP blocks inline/eval paths; private keys are not unlocked before bundle verification. The **conditional** test — the local key agent refuses an unverified origin/bundle — runs **only when WS-S.10.3 (the Tier-3 agent) is in scope** per the §30.3 decision; when v1 launches Tier 1/2 only, this test is skipped (not failed) and the launch checklist is satisfied without it. This keeps the launch checklist completable when the agent is descoped while never weakening the always-required bundle-lock guarantees.

**Acceptance criteria:**
- The five mandatory scenarios pass on every launch path; keys never unlock before verification; CSP/Trusted-Types/no-dynamic-code + SW pinning are asserted.
- The key-agent refusal test is gated on the §30.3 in-scope flag — it runs and passes when the agent is shipped, and is cleanly skipped (checklist still green) when v1 is Tier 1/2 only.

**Testing:** E2E + unit — the five mandatory cases (lock-on-unsigned/mismatch; CSP-blocks-eval; no-unlock-before-verify); plus the conditional key-agent-refuses-unverified case behind the WS-S.10.3-in-scope flag.

**Dependencies:** WS-S.10.2b (mandatory); WS-S.10.3 (conditional — only if the Tier-3 agent is in v1 scope, §30.3).

---

### WS-S.11.5 Incident runbooks + operational controls
**ID:** WS-S.11.5 | **Ref:** PRIVATE_SPEC §27

**Description:** Author the §27 operational controls + incident runbooks: the allowed/forbidden operational-log lists (§27.1); rendezvous abuse controls (§27.2); and the three incident playbooks — leaked invite (revoke capability, rotate epoch if used, review members, show changes since invite; server may rate-limit invite spam / delist a stub but cannot remove private members), compromised device (remove device, rotate epoch, new recovery kit, mark compromised, optionally tombstone suspicious ops; disclose that content already on the device may be exposed), and malicious client update (transparency log detects/prevents, rooms lock before unlock, signed incident notice, rotate keys after a verified-safe client, encourage local key agent).

**Acceptance criteria:**
- The allowed/forbidden log lists are codified and enforced by `check:no-private-cid-egress`.
- Each incident playbook has concrete user + server actions and honest disclosure copy.
- Support runbooks never promise impossible recovery/moderation.

**Testing:** Doc review gate + `check:no-private-cid-egress`; a tabletop incident-drill checklist (§26.7).

**Dependencies:** WS-S.1.5, WS-S.3.6b, WS-S.3.6c.

---

### WS-S.11.6 External audits, launch checklist, docs/index/version
**ID:** WS-S.11.6 | **Ref:** PRIVATE_SPEC §26.7, §29; Documentation rules (CLAUDE.md)

**Description:** Gate launch on the §26.7 manual review (external cryptography review; browser storage/key-management review; rendezvous metadata review; red-team malicious-server-update; malicious-member scenario; leaked-invite + compromised-device drills; recovery-warning usability study) and the §29 launch checklist (product/UX, server non-storage, crypto, P2P/IPFS, trust/update-channel, safety). In the same change set, add `docs/private-p2p/README.md`, register WS-S in `docs/planning/00-index.md`, update the `CLAUDE.md`/`AGENTS.md` roadmap row (byte-identical), and bump the root `package.json` PATCH version. No `claude.ai/code/session_*` URL in any doc or PR body.

**Acceptance criteria:**
- Every §29 launch-checklist item is satisfied or explicitly waived with rationale; the external audits are complete and tracked.
- The master index lists WS-S; `CLAUDE.md ≡ AGENTS.md` (empty `diff`); version bumped; no session URL anywhere.
- No support doc promises impossible recovery/moderation.

**Testing:** `pnpm check:policy`; CLAUDE.md ≡ AGENTS.md assertion; the §29 checklist sign-off.

**Dependencies:** all WS-S implementation cards (lands with them).

---

## Unified dependency graph (WS-R + WS-S + the cross-plane seam)

The two planes are **independently buildable** and meet at exactly one optional seam (the cross-plane edges below). Each plane's internal graph is reproduced verbatim from its source plan; both are acyclic, and the combined graph stays acyclic because the seam is one-directional.

### Part I — WS-R (offline availability & transport) — internal dependency graph

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
R.12.2 ─ R.9.1 ─ R.9.2a ─ R.9.2b ─ R.9.3a ─ R.9.3b ─ R.9.4                     (room log → Merkle/checkpoint → proofs → witness)
R.12.2 ─ R.12.1a ─ R.12.1b (←R.8.2c) ─ R.12.1c (←R.9.1, R.12.3, R.10.2)   ;   R.12.2 ─ R.12.3
R.12.1c/R.6.2/R.9.3a/R.9.3b ─ R.12.4
R.10.2 ─ R.10.1 ; R.11.3b ─ R.10.3
R.11.3a ─ R.11.1 ─ R.11.3b ; R.11.1 ─ R.11.2 ─ R.11.4 ; R.2.1/R.1.2 ─ R.11.5
R.8.2c/R.2.4/R.9.4 ─ R.13.1 ─ R.13.2
R.4.2 ─ R.14.1a ─ R.14.1b ; R.6.3/R.4.4 ─ R.14.2 ; R.0.7 ─ R.14.3 ; R.0.7 ─ R.14.4
R.4.1/R.14.2 ─ R.15.1a ; R.4.2/R.4.3/R.8.3 ─ R.15.1b ; R.6.1 ─ R.15.2 ; R.12.4/R.14.4 ─ R.15.3
R.15.1a/R.15.1b/R.11.4 ─ R.15.4a ─ R.15.4b ─ R.15.4c ─ R.15.4d ; R.15.4b ─ R.15.4e ; R.15.4d/R.15.4e/R.18.3a ─ R.15.4f   (Capacitor courier)
R.12.4 ─ R.15.5 (WebTransport) ; R.15.4b/R.12.4 ─ R.15.6a ─ R.15.6b ; R.15.6a ─ R.15.7a ─ R.15.7b   (WebRTC ; Helia IPFS bridge)
R.15.6a/R.15.7a ─ R.15.8 (budget+egress gate) ; R.15.5/R.15.6b/R.15.7b/R.18.3a ─ R.15.9 (transport sim/interop)
R.2.1/R.11.5 ─ R.16.1  (bridge to WS-S)
R.8.1/R.10.1 ─ R.17.1 ─ R.17.3 ; R.11.2/R.6.2 ─ R.17.2
R.0.6b/R.9.3a/R.9.3b ─ R.18.1 ; R.5.4/R.8.3/R.10.3 ─ R.18.2 ; R.8.3/R.9.4/R.5.4 ─ R.18.3a ─ R.18.3b
R.14.1a/R.14.1b/R.0.8/R.4.2 ─ R.18.4 ; R.18.1/R.15.1a/R.15.1b ─ R.18.5 ; (all) ─ R.18.6
```

The graph is acyclic. Three cycles present in earlier cuts were removed: the pack writer (R.4.1) now takes a **caller-provided** object order rather than build-depending on the scheduler (R.5.2c); the room-log append (R.9.1) is a DB primitive that the ingestion commit stage (R.12.1c) *calls* rather than the reverse; and the relay quota policy (R.14.4) is standalone (depends only on the schemas R.0.7) while the relay service (R.15.3) *consumes* it — the first cut had R.14.4↔R.15.3 mutually depending. The dependency-closure helper (R.7.2) is scheduler-independent and feeds R.5.2a. The **elevated transports keep the graph acyclic**: the shared `LcapTransport` seam (R.15.4b) depends only on the validated core (R.4.2/R.5.2c/R.8.3) and is *consumed* by the courier (R.15.4c–f), WebRTC (R.15.6a), and WebTransport (R.15.5); the IPFS bridge (R.15.7a) rides the WebRTC P2P groundwork (R.15.6a) and the CID/block layer (R.0.3/R.3.1); and R.15.4f/R.15.9 depend on the simulator (R.18.3a), which depends on the core (R.8.3/R.9.4/R.5.4), never on any R.15 transport — so there is no back-edge from the transports into the simulator.

Cross-stream order: **R.0** (LDC codec → CID → AAD → ECDSA → COSE → schemas → suites) is the gate for everything. Then **R.1** (identity/capabilities/revocations) and **R.2/R.3** (records/blocks) in parallel; **R.5** (closure → scheduler front → DRR → score) and **R.4** (pack) co-develop but are decoupled (the writer consumes the scheduler's emitted order at integration in R.15.1); **R.6/R.7/R.8** (sync/reconciliation/trust) build on records + scheduler; **R.9** (checkpoints) sits on the server **R.12** DB; **R.10/R.11** (liveness/storage) underpin the client; **R.13/R.14** (conflict/privacy-DoS) harden; **R.15** (the now-elevated transports — manual bundle/QR/relay **plus** the first-class WebTransport, WebRTC P2P, browser-IPFS bridge, and native Capacitor courier) and **R.16** (private bridge) and **R.17** (UI) ride the validated core; **R.18** (tests/sim/acceptance) runs continuously and gates the close. The phase mapping to OFFLINE_SPEC §35 (correspondingly de-deferred in the spec) is: Phase 0 = R.0; Phase 1 = R.1/R.6/R.11/R.12; Phase 2 = R.3/R.4/R.5/R.15.1–2; Phase 3 = R.9/R.10; **Phase 4 = R.15.3 (relay) + R.15.5 (WebTransport)**; **Phase 5 = R.15.4a–f (native Capacitor courier) + R.15.6a/b (WebRTC P2P)**; **Phase 6 = R.15.7a/b (browser-IPFS public bridge) + R.15.8 (transport budget/egress gate) + R.15.9 (transport simulation/interop) + R.7.3/R.16/witness hardening/PQ reservation**. Because the transports depend on the validated core, "elevated priority" pulls the *workstream* earlier (Wave 8) and makes these transports **required, not optional** — it does not reorder them ahead of R.0–R.14, which they require by construction.


### Part II — WS-S (private rooms — confidentiality & authority) — internal dependency graph

```
S.0.1 ─ S.0.2 ─ S.0.3
S.0.1 ─ S.1.1 ─┬─ S.1.2 ─┐
               ├─ S.1.3  ├─ S.1.5            (server non-storage gates)
               └─ S.1.4 ─┘
S.2.1 ─ S.2.2 ─ S.2.3
S.2.3 ─ S.3.1a ─ S.3.1b ─ S.3.2 ─ S.3.3a ─ S.3.3b        (MLS → exporter → HKDF → body AEAD → key-wrap)
S.3.1a ─ S.3.4 ; S.2.2 ─ S.3.5 ; S.3.1a/3.5 ─ S.3.6a ─ S.3.6b ; S.3.6a/S.5.1 ─ S.3.6c ; S.3.3a/3.3b/3.4/3.5 ─ S.3.7
S.2.1 ─ S.4.1 ─ S.4.2 ─ S.4.4 ; S.4.1 + S.6.3 ─ S.4.3
S.2.3/S.3.1a ─ S.5.1 ─ S.5.2 ─ S.5.3a ─ S.5.3b ─ S.5.3c ─ S.5.4a ─ S.5.4b   (ops → validate ×3 → order → fold)
S.5.4b ─ S.5.5 ─ S.5.6 ; S.5.4b ─ S.5.8 ; S.5.2 ─ S.5.7
S.3.2 ─ S.6.1a ─ S.6.1b ; S.6.1a ─ S.6.2 ; S.3.5/S.6.1a ─ S.6.3 ─ S.6.4 ; S.5.3a ─ S.6.5 ; S.1.2/S.6.1a ─ S.6.6
S.5.4b/S.3.6b/S.10.2b ─ S.7.1 ; S.7.4 ─ S.7.2 ─ S.7.3 ; S.3.4/S.5.1 ─ S.7.4 ; S.7.2/S.10.2b ─ S.7.5
S.5.2 ─ S.8.1a ─ S.8.1b ─ S.8.2 ; S.8.1b ─ S.8.3
S.0.2 ─ S.9.1 ; S.7.1/S.7.4 ─ S.9.2a ─ S.9.2b ─ S.9.3
S.2.1 ─ S.10.1 ─ S.10.2a ─ S.10.2b ; S.3.6a/S.10.2a ─ S.10.3
S.3.7/S.5.5 ─ S.11.1 ; S.7.4/S.6.6/S.8.1b ─ S.11.2 ; S.1.5/S.6.4 ─ S.11.3 ; S.10.2b/S.10.3 ─ S.11.4 ; S.1.5/S.3.6b/S.3.6c ─ S.11.5 ; (all) ─ S.11.6
```

The graph is acyclic. Note the one apparent back-edge `S.4.1 + S.6.3 ─ S.4.3`: the private block-exchange protocols (S.4.3) gate on the membership-proving handshake (S.6.3), which depends on S.6.1a and S.3.5, not on S.4.3 — so the order is S.4.1/S.3.5/S.6.1a → S.6.3 → S.4.3, with no loop.

Cross-stream order: **S.0** (model/terminology) and **S.1** (server non-storage gates — landable immediately, independent of the crypto/P2P stack) come first; **S.2** (schemas/canonical) gates **S.3** (crypto: MLS → exporter → HKDF → body/key-wrap AEAD) and **S.5** (ops → 3-stage validate → Lamport order → fold); **S.4** (Helia/libp2p) and **S.6** (sync/rendezvous) build the transport on the crypto + reducer; **S.7** (UI) and **S.8** (media) ride the validated local state; **S.9** (migration) follows the UI; **S.10** (update channel) is foundational for **S.7.1**'s create-time bundle gate and lands alongside the UI; **S.11** (audit/tests/launch) runs continuously and gates the close. **S.1 can ship and harden well before the rest of WS-S** — defensive server gates first, so a partially-built P2P client can never accidentally write server content.


### Cross-plane edges — the single composition seam

```
WS-R.16.1 (LCAP EncryptedPayloadDescriptorV2 carrier)  ── carries ─> WS-S ciphertext blocks + opaque room hints
WS-R.11.5 (private-content replication policy)          ── default-denies ─> private content over LCAP transports unless encrypted+permitted
WS-S.6.5  (offline CAR exchange + optional LCAP bundle) ── reuses ──> the WS-R .licio-bundle pack / lane scheduler / liveness labelling
```

These are the **only** inter-plane edges; they are one-directional and optional. LCAP carries WS-S ciphertext but never sees plaintext, keys, op-heads, or real private-room ids; WS-S owns all key authority and can ship without LCAP (it has its own CAR/offline path). There is no edge from WS-S into the LCAP trust/validation core, nor from LCAP into the WS-S key schedule, so the combined graph remains acyclic.

## Unified cross-stream order, phases, and waves

The two planes parallelize. Within each, the per-plane "Cross-stream order" notes above are authoritative; across them:

- **Foundations first, independently.** WS-R.0 (codec/CID/COSE/schemas) gates all of Part I; WS-S.0/WS-S.1 (room-class model + the server **non-storage gates**) gate all of Part II and are **landable immediately** — the defensive server gates ship first so a partially-built P2P client can never write server content.
- **The two crypto/transport stacks build in parallel.** Part I's identity/records/scheduler/sync/trust (R.1–R.8) and Part II's canonical-encoding/crypto/reducer (S.2/S.3/S.5) have no cross-dependency; the shared `check:no-applause`/`check:no-raw-egress` extensions and the per-plane egress gates (R.14.3 / S.1.5) land with their respective trees.
- **The seam lands late and optionally.** WS-R.16.1 and WS-S.6.5 integrate only after both planes' cores exist; neither blocks the other's close.
- **Waves.** WS-R is **Wave 8** (elevated to P1; its dependencies WS-C/D/E/F/G/Q are all complete, so it has no remaining hard predecessor). WS-S is **Wave 11** (parallelizable with WS-R; WS-S.1 server gates landable first; WS-S.10 update channel consumes WS-O). With two teams the planes run concurrently (~18–24 weeks, WS-S the long pole); single-team, WS-R precedes WS-S.
- **Phase mapping.** Part I follows OFFLINE_SPEC §35 (Phase 0 = R.0 … Phase 6 = R.15.7/15.8/15.9 + R.7.3/R.16/witness/PQ). Part II follows PRIVATE_SPEC §28 (WS-P2P-0…11 ≈ S.0…S.11): server gates → schemas/canonical → crypto → Helia/libp2p → reducer → sync/rendezvous → UI/media → migration → update channel → audit/launch.

## Unified milestone gates

**Cross-plane gates** (the shared-foundations invariants):

| Gate | Cards | Requirement |
|---|---|---|
| Crypto-suite separation & no key sharing | WS-R.0.5a/0.8, WS-S.3.1a/3.5 | The planes pin different suites (ES256 vs Ed25519/MLS/HPKE) and share no keys or signers; neither plane's compromise crosses into the other. |
| P2P dependency isolation | WS-R.15.8, WS-S.2.1 | `@licio/lcap-p2p` and `packages/private-p2p` are `workspace:*`-excluded + code-split; the `apps/web` `<15` direct-dep budget and the < 200 KB initial-bundle gate hold for both, and `apps/courier` Capacitor deps stay native-scoped. |
| Composition seam (ciphertext-only) | WS-R.16.1, WS-R.11.5, WS-S.6.5 | LCAP carries only WS-S ciphertext + opaque hints; no plaintext / key / op-head / real-private-room-id crosses the seam; PRIVATE_SPEC wins for private-room content. |
| Docs byte-identical + version | WS-R.18.6, WS-S.11.6 | CLAUDE.md ≡ AGENTS.md; README + this index entry updated; PATCH version bumped; no `claude.ai/code/session_*` URL in any doc or PR body. |

**Part I — WS-R gates:**

| Gate | Cards | Requirement |
|---|---|---|
| Record/proof separation | R.0.3, R.0.6a, R.18.2 | `record_cid` is independent of signature bytes; multi-proof never changes identity. |
| Deterministic encoding | R.0.2a, R.0.2c, R.18.1 | LDC vectors stable; same logical value ⇒ identical bytes; closed-schema unknown-field rejection. |
| Crypto interop | R.0.5a, R.0.5b, R.18.5 | Browser↔Node ES256 low-S sign/verify and bundle round-trip pass. |
| No transport trust | R.8.2c, R.8.3 | Every ingress funnels through the single `validate`; hostile relay ≡ trusted friend in trust state. |
| C0 cannot starve | R.5.2b, R.5.4 | C0 reservation precedes DRR; `check:lcap-scheduler` proves control/dependency closure never preempted by media/bulk. |
| Outbox durability | R.10.3 | Hard pins survive eviction; signed-unsent records retry on every opportunity. |
| Revocation propagation | R.1.4, R.7.1 | Revocations are P0/C0, reconciled before content; stale frontiers labelled. |
| Checkpoint consistency | R.9.2a/b, R.9.3a/b, R.9.4 | Inclusion/consistency verify (RFC 9162-compatible); equivocation → gossiped fork evidence. |
| LCAP doctrine | R.14.3 | No raw attention/IP/location/applause field in any LCAP schema; gates in CI. |
| Honest UI | R.17.1 | No single "verified"/"delivered" badge; provisional/stale/conflict/revoked/rejected explicit. |
| Malformed-pack safety | R.4.2, R.14.1a/b, R.18.4 | Bombs/forks/downgrade/replay rejected; nothing renders before trust projection. |
| Transports first-class | R.15.4a–f, R.15.5, R.15.6a/b, R.15.7a/b, R.15.9 | Native Capacitor courier + WebTransport + WebRTC P2P + browser-IPFS public bridge ship as **required** transports reusing the same packs / `validate` / scheduler; the correctness-independent-of-transport property holds (any transport subset, HTTPS-only included, reaches the identical accepted set + trust state). |
| Transport privacy + budget | R.15.4e, R.15.6b, R.15.7b, R.15.8 | No peer IP / multiaddr / radio identifier in any LCAP schema (`check:lcap-schema-egress` over `@licio/lcap-p2p` + `apps/courier`); the P2P deps are workspace-excluded + separately code-split (the `<15` web budget and < 200 KB initial-bundle gate hold); IPFS publishes public blocks only behind the review gate; all P2P/courier reach is off by default and Stealth/Emergency-disabled. |
| Docs byte-identical | R.18.6 | CLAUDE.md ≡ AGENTS.md; README + index updated; version bumped; no session URL. |


**Part II — WS-S gates:**

| Gate | Cards | Requirement |
|---|---|---|
| Server non-storage | S.1.3, S.1.4, S.1.5 | P2P rooms cannot create server stories/contributions/uploads, never enter ranking/search, emit no content events; DB assertion proves zero rows after E2E. |
| Encrypt-before-CID | S.4.2, S.4.4 | Every private CID is over ciphertext; no plaintext CID; public-gateway URL construction for a private CID is unreachable. |
| Group-key authority | S.3.1a, S.3.1b, S.5.1 | MLS add/remove rotates the epoch (one atomic key/topic/blind-id rotation); no platform role authorizes any private-room op; removed devices cannot decrypt future epochs. |
| Canonical determinism | S.2.2, S.5.4a, S.5.4b | One DAG-CBOR profile pins AAD/signatures/CIDs/reducer; the Lamport order extends causality; reducer output is byte-identical across shuffled delivery. |
| AAD/nonce discipline | S.3.3a, S.3.3b, S.3.7 | Body and key-wrap AADs are canonical fixed-shape; fresh object key + nonce per object; `wrapping_epoch`-bound wrap; nonce reuse is impossible (asserted). |
| No metadata egress | S.11.2 | No outbound request carries private title/body/URL/CID/op-id/thread-id/member-list/invite-fragment/key/exact-unlisted-room-id. |
| Update-channel trust | S.10.1, S.10.2a/b | Reproducible signed private bundle in a transparency log; keys never unlock on an unverified bundle; rooms lock. |
| Honest non-goals | S.0.3, S.7.5 | Creation/removal disclosures + Tier-1 limitation + replication/recovery honesty shown in-product. |
| Dependency budget | S.2.1 | Heavy P2P deps isolated to the workspace + lazy chunk; `apps/web` budget and initial-bundle gate unchanged. |
| Docs byte-identical | S.11.6 | CLAUDE.md ≡ AGENTS.md; README + index updated; version bumped; no session URL. |

## Definition of done (the combined Decentralized Data Plane upgrade)

**Cross-plane:**

- The two planes are delivered as deliberately-separated layers over one content-addressed substrate: WS-R keeps content server-visible-but-portable; WS-S makes `private_p2p` content server-invisible. They share no keys, pin different crypto suites (ES256 vs Ed25519/MLS/HPKE), and meet only at the ciphertext-carrying seam (WS-R.16.1 ↔ WS-S.6.5), where no plaintext/key/op-head/real-private-room-id ever crosses.
- Both heavy P2P/crypto stacks are isolated to their `workspace:*` packages (`@licio/lcap-p2p`, `packages/private-p2p`) + dynamically-imported code-split chunks (and the courier to the `apps/courier` native shell), so the `apps/web` `< 15` direct-production-dep budget and the < 200 KB gz initial-bundle gate are unaffected by either plane.
- The shared doctrine gates (`check:no-applause`, `check:no-raw-egress`) and each plane's egress gates (WS-R `check:lcap-schema-egress`; the seven WS-S `check:*p2p*`/`check:*private*`) pass over every new tree; no attention/IP/location/applause/financial/private-metadata field appears in any schema of either plane.

**Part I — WS-R is done when:**

- LCAP records are identified by the deterministic body hash only; signatures are detached COSE_Sign1 proofs; `record_cid` is independent of proof bytes, pinned by conformance vectors that pass in browser and Node.
- The full trust pipeline — device certificate → capability → device proof → revocation knowledge → checkpoint inclusion/consistency → witnesses — is implemented; **every** ingress (HTTPS, manual bundle, QR, relay, WebTransport, WebRTC P2P, browser-IPFS bridge, native Capacitor courier) funnels through the single shared `validate(record_cid)` via one `LcapTransport` seam, and the path of arrival never confers trust.
- The lane scheduler guarantees C0/dependency closure can never be starved by media/bulk, proven by the named `check:lcap-scheduler` gate and the §32.2 property suite; the durable outbox hard-pins local material against eviction.
- Server ingestion quarantines before commit, accepts idempotently by `record_cid`, appends topologically to the room log, issues signed receipts, and exposes the §29 endpoints with the §22.1.1 HTTP status mapping; the `lcap_v2` IndexedDB and the new `lcap_*` Postgres tables coexist with the shipped stores without migration of either.
- Manual `.licio-bundle` export/import is a first-class transport with full privacy disclosure; QR micro-bundles carry C0 control material; the untrusted relay can store/serve/receipt but never accept; and — per the 2026-06 maintainer decision — the **native Capacitor courier (Nearby Connections / Wi-Fi Direct / Bluetooth / hotspot / USB), WebTransport (HTTP/3), WebRTC browser↔browser P2P, and the browser-IPFS/libp2p public-block bridge are all shipped, first-class transports** (not deferrals): each reuses the same packs and the single trust path, is off by default and consent-gated per mode (Stealth/Emergency-disabled), exposes no transport-layer metadata into any LCAP schema, and confines its dependencies to the code-split `@licio/lcap-p2p` workspace package or the `apps/courier` native shell so the web `<15` dep budget and the < 200 KB initial-bundle gate hold; the IPFS bridge publishes public blocks only behind a required privacy/moderation/abuse-review gate.
- Private-room content is carried as ciphertext + opaque hints only; LCAP owns no group-key authority (that is WS-S / PRIVATE_SPEC §10), and no plaintext/key/op-head/real-private-room-id ever enters an LCAP record, log, or receipt.
- The UI exposes trust and liveness as distinct, honest, accessible states (WCAG 2.2 AA), never collapsing them into one badge and never using *secure/trusted/delivered/final/safe* without exact meaning; the six operational modes (incl. Emergency text and Stealth) apply their budget/discovery policies.
- The deterministic-vector, property, network-simulation, security/fuzz, and browser↔Node interop suites pass; the §36 acceptance gates are wired in CI; high-risk/private-room use is documented as gated on external security review.

**Part II — WS-S is done when:**

- Private P2P rooms are a separate, end-to-end-encrypted storage/sync/trust/authority plane: room content/threads/comments/media/membership/search are encrypted on members' devices, and platform staff cannot read, alter, recover, moderate, add members to, or delete them.
- The server non-storage contract is enforced structurally — a column denylist on the stub/rendezvous tables, endpoint rejection guards, retriever/search predicates, an event-pipeline gate, and seven CI checks — and a post-E2E DB assertion proves zero private content rows; server logs exclude private CIDs/op-ids/invite-fragments/member-lists/titles/bodies/exact activity.
- Group keying is MLS, invite bootstrap is HPKE, signatures are Ed25519, and every key is derived from the per-epoch exporter via the labeled HKDF schedule; one MLS commit rotates all operational keys and removed devices cannot decrypt future epochs; no custom group crypto exists.
- Every private object is encrypt-before-content-address (CID over ciphertext), wrapped with a fresh per-object key + nonce under canonical fixed-shape AADs; the private Helia/libp2p profile disables all public DHT/gateway/delegated-routing/IPNI/reprovide, and a public-gateway URL for a private CID is unreachable at runtime and in CI.
- The deterministic Lamport-ordered reducer produces byte-identical state across devices regardless of delivery order; the op-validation pipeline quarantines (never renders) unauthorized/removed-device/missing-parent/unknown-schema ops; conflicts resolve by total order with full encrypted history retained.
- Blind rendezvous, encrypted signaling, the membership-proving handshake, head/block exchange, relay-only mode, and offline CAR/`.licio-bundle` import all carry ciphertext + opaque hints only; rendezvous is member-capability-gated, metadata-minimized, and not a room-existence oracle.
- The UI states every honest limit (members can copy; removal is not retroactive; availability depends on member devices; Licio cannot recover; Tier-1 does not stop a malicious web update); the update channel ships a reproducible, signed, transparency-logged private bundle and locks rooms before unlocking keys on any unverified build; an optional Tier-3 local key agent never exposes raw keys to web JS.
- Migration creates a NEW P2P room (never an in-place upgrade), discloses that imported history was server-hosted, re-invites members via P2P, freezes and minimizes the old server room, and never promises retroactive privacy.
- The unit/crypto-vector/fuzz, network request-capture, server-DB-no-content, multi-peer sync, and update-channel suites pass; external cryptography/storage/metadata/red-team reviews are complete; the §29 launch checklist is satisfied.

**Combined verification (both planes):**

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm lint:security`, `pnpm check:deps`, `pnpm check:workspace-deps`, `pnpm check:no-applause`, `pnpm check:no-raw-egress`, `pnpm check:policy`, plus the **Part I** gates (`check:lcap-schema-egress`, `check:lcap-scheduler`, `check:sw`) and the **Part II** gates (the seven `check:*p2p*`/`check:*private*` checks) all pass; the web LCAP core, the `@licio/lcap-p2p` transport chunk, and the `packages/private-p2p` private chunk are each code-split and workspace-isolated (the < 200 KB initial-bundle gate and the `apps/web` `< 15` budget hold), both new workspace packages are registered in `scripts/check-workspace-deps.ts`, and the `apps/courier` Capacitor native build is green in CI; docs are updated in the same change set and the PATCH version is bumped.
