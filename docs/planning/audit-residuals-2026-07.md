# Deep-audit residuals — 2026-07

Tracked debt from the 2026-07 deep audit (see the `audit/deep-remediation-2026-07`
branch / its PR for the ~40 findings already fixed). The fan-out audit ran 26
read-only finders; its adversarial-verify phase was cut short by a model spend
limit, so the items BELOW are **audit-surfaced candidates that still need
per-item verification** before remediation — some may prove to be false
positives. They are recorded here (not left as in-source TODOs) per the
`CLAUDE.md` implement-the-improvement deferral rule.

Closure target: fold into the relevant workstream cut; **verify each against the
code first**, then implement the improvement (never weaken the doc/type). For the
dead-component group the maintainer's directional decision is **wire up the
SPEC-required components, remove pure duplicates — do NOT delete SPEC features**.

## Component wire-ups (SPEC affordances defined but never mounted)

`OfflineState` (WS-B.2.5) was wired up in this pass. Remaining:

- **BlockMuteButtons** (`components/safety/SafetyRelations.tsx`) — WS-J block/mute
  is unreachable in the UI. HIGH (safety affordance).
- **AiLabel** (`components/ai/AiLabel.tsx`) — the WS-K AI provenance badge renders
  on no AI-produced artifact (summaries, debate verdicts, AI moderation notices).
- **DisabledFeatureExplanation** (`components/compliance/`) — the WS-N feature×reason
  matrix component is never mounted.
- **i18n catalog loading never wired** (`main.tsx`) — the German WS-N.1.2b catalog
  is unreachable; the app is hard-pinned to `en`. HIGH (compliance/locale).
- **ComposerAffordances** (Attachment / CitationCapture / PrivacyWarning) and the
  two parallel **VoiceDictation** implementations — none mounted; pick one.
- **SwipeableStoryCard** + `useStoryCardSwipe` (WS-B.2.2 gestures) — never mounted.
- **SourceReader reader-mode** — the readability engine is unreachable because the
  sole caller passes no source HTML.
- **SectionEndpoint** ("you're all caught up") — never mounted at feed end.
- **FocusModeToggle** — the profile page re-implements the same toggle inline with
  a raw Switch; use the component (dedup).
- **ScrollArea / SafeArea** primitives and **jargon** (`findJargon`/`hasJargon`
  plain-language audit) — unused; wire in or remove per the rule.

## Correctness — client (candidates)

- `signals/processor.ts` — hidden-tab time counted as active dwell up to the cap.
- `offline/db.ts` — migrations 4+5 interleave two read-modify-write cursors on the
  same stores, risking loss of the `schemaVersion` stamp. HIGH.
- `offline/read-through.ts` — `saveStory` always writes `roomId: null`, leaving the
  roomId index permanently empty.
- `offline/eviction.ts` — acked-removal counter resets per session while the
  snapshot persists (early drain misreported as eviction).
- `offline/sync.ts` — no app-open queue flush on iOS Safari/Firefox.
- `components/wallet/TransactionPreview.tsx` — `related_link` renders into an anchor
  `href` with no URL-scheme validation. Verify against the link-safety layer.
- `design-system/css.ts` — z-index custom properties hardcoded instead of derived
  from the `zIndexScale` SSOT; `UgcBody` `compact` class has no CSS rule.

## Correctness — server (candidates)

- `forum/contributions.ts` — attachment re-use re-points `ownerStoryId`, potentially
  resurrecting taken-down media. HIGH (safety).
- `events/ingest.ts` — cross-surface replay of `none`-retention users' events via the
  7-day batch wire; accepted-events log pairs the real user id with pseudonymized
  event_ids. HIGH (privacy). Verify carefully.
- `pwatt/aggregation.ts` — `computedAt` stamped after the event read can permanently
  skip concurrent arrivals via the freshness check.
- `events/consumers.ts` — volume-trigger threshold captured once at boot (runtime
  `trigger_threshold` config has no effect).
- `invariants/{services,data,scoi-actions}.ts` — MFCI/SCOI/Hodge include
  held/removed contributions in their structure; MERI redundancy cache is unbounded;
  `bridgeCandidatesFor` counts non-published contributions.
- `ranking/service.ts` — topic-surface sensitivity check ignores the slug→UUID
  resolution the pool filter applies.
- `ingestion/pipeline.ts` — extraction retries never terminate (dead links retry
  forever within the hourly budget).
- `moderation/review.ts` — appeal-queue `filtered_total` returns the page size, not
  the true filter count (needs an appeal-store `count()`).
- `ai-governance-admin.ts` — deprecate/review-resolve parse raw JSON without zod.
- `middleware/csrf.ts` — `GET /api/csrf-token` mints+stores tokens for unvalidated
  cookies with no rate limit (unbounded unauthenticated store writes); `setSessionCookie`
  is production-dead.
- `middleware/cors.ts` — `Access-Control-Allow-Methods` omits PUT; `CORS_ORIGIN` used
  raw (a trailing slash/path bricks mutations).
- `identity/{siwe,email-otp}.ts` — OTP records read back from the ephemeral store are
  not zod-validated at the trust boundary (siwe nonce-burn was fixed this pass).
- `routes/auth-mfa.ts` — TOTP disable is step-up-guarded but does not require the
  CURRENT factor; assess whether WS-D.1.5b needs the stronger guard.
- Store parity: `DrizzleEventStore.insertMany` drops caller `createdAt`;
  `DrizzleStoryStore.update` never bumps `updated_at`; signal-ledger keyset order
  diverges from the in-memory store.
- `governance/law-pack-validate.ts` — fixture harness ignores role_class quorum basis.
- `ranking/diversify/balancing.ts` — graceful-degradation fill leaves the served page
  out of score order.
- `shared/schemas/attention.ts` — `session_bucket` unbounded on the batch wire but
  capped at 64 in the canonical schema → conversion throws 500 instead of 4xx.

## Private-P2P / update-channel security (candidates — verify with care)

- `update/install-sw-pinning.ts` — SW-update gate ignores `isUpdateChannelConfigured`
  (may refuse updates on unpinned deployments).
- `lcap/cross-plane-bridge.ts` and `private-p2p/room-manager.ts` — dynamic-import the
  private-p2p chunk without the §20.6 verify-before-execute gate.
- `update/gate.ts` — pending-bundle verification writes its verdict into the
  RUNNING-bundle gate state.
- `private-p2p/room-manager.ts` — invite `max_uses` never enforced (no caller supplies
  `usesSoFar`); `leave()` deletes only the session row, leaving envelopes/blocks/Tier-2
  cap secrets. HIGH (private-room hygiene).
- `private-p2p/sync-session.ts` — `maintainConnection` can leak a live session when
  `close()` races an in-flight dial.
- `lcap/sync-boot.ts` — SW background-sync trigger bypasses Emergency mode's
  `backgroundSync:false`.

## Feature-flags plane (candidates)

- `stores/feature-flags.ts` — the documented §21.3 jurisdiction-disable actions are
  never dispatched; `query-client.ts` `cachePolicy.featureFlags`/`queryKeys.featureFlags`
  are dead (no always-fresh flags query). Wire the flags query or remove the dead policy.
