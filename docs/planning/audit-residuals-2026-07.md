# Deep-audit residuals — 2026-07

Tracked debt from the 2026-07 deep audit (branch `audit/deep-remediation-2026-07`).
The fan-out audit surfaced 105 candidate findings; ~55 were verified and fixed on
the branch (see its commit history). This file records the remainder, each
verified against the code, per the `CLAUDE.md` implement-the-improvement deferral
rule.

Verification note: candidates were checked one-by-one (a read-only per-candidate
pass plus main-loop code reading). Three finder claims were **refuted** as false
positives on the current code: `wallet/TransactionPreview` `related_link` (the
href is a validated same-origin path), `ranking/service` topic slug→UUID (the
resolution IS applied), and `DrizzleStoryStore.update` `updated_at` (it is
bumped). They need no action.

## WS-S Private-P2P plane — feature-completion

All four items below are now FIXED (see the branch history). Kept here as a record:

- **Invite `max_uses` enforcement** — DONE. `IndexedDbPrivateRoomStorage` gained a
  v5 `invite_uses` store + `getInviteUses`/`incrementInviteUses`;
  `admitJoinRequestImpl` reads the persisted count into `verifyJoinRequest` and
  charges one use on success, so a single-use invite is `exhausted` on re-admit.
- **`leave()` cleanup** — DONE. `deleteAllForRoom()` atomically purges every
  compound-keyed store (envelopes, blocks, cap secrets, invite counters) for the
  room in one transaction; `leave()` calls it before deleting the session row.
- **sync-session dial/close race** — DONE. `maintainConnection` re-checks
  `stopping` after the awaited dial and closes the raced session (mirrors
  `maintainMesh`), never surfacing it as `connected`.
- **Pending-bundle verdict vs running-bundle gate state** — DONE. `runVerification`
  now publishes only RUNNING verdicts (`!pending` guard); the SW-activation caller
  consumes the returned verdict, and the `resetPrivateBundleGate()` clobber was
  removed.
- NOT bugs (intended boundaries, verified): the cross-plane bridge + parseInvite/
  parseJoinRequest dynamic-import `@licio/private-p2p` WITHOUT the §20.6 gate —
  that gate guards KEY UNLOCK (applied at `loadPrivateRoomEngine` →
  `ensurePrivateBundleTrusted`), and these paths only parse OPAQUE data (no keys,
  no decryption; re-verified later by the gated engine). The SW-activation gate
  (`sw-pinning.ts`) intentionally locks even on an unconfigured channel (stricter
  than the room-key surface, per its tests) — do NOT add an
  `isUpdateChannelConfigured` fast-path without a maintainer security decision.

## Correctness / privacy — tractable, not yet done

- **DSAR omits WS-T debate-arena data** (`forum/data-rights.ts`): the account
  export + anonymize skip the user's debate rebuttal text and party ids. Needs a
  debate-store `listByParty(userId)` query (the store has incumbent/challenger
  user ids but no by-user index yet), then wire it into the export + anonymize.

## Server-side items — now FIXED (kept as a record)

- **Cross-surface replay nonce** (`events/ingest.ts`) — DONE. The replay nonce is
  sized to `MAX_INGEST_WINDOW_MS` (the 7-day offline ceiling) for EVERY surface,
  not the per-request policy, closing the online-then-offline replay hole for
  short-retention users.
- **Live volume-trigger threshold** (`events/consumers.ts`) — DONE. The realtime
  consumer refreshes the runtime `trigger_threshold` via a shared
  `loadTriggerThreshold()` reader (≤ once/min, per-instance), so tuning applies
  without a restart.
- **`/api/csrf-token` unbounded writes** (`middleware/csrf.ts`) — DONE. The mint
  route now validates the session exists (via `validateSession`) before minting,
  so a forged cookie cannot grow the token store; a validation outage fails closed
  (503).
- **ioredis connection consolidation** (`index.ts`) — DONE. One shared command
  client backs every command consumer; only the two pub/sub subscribers stay
  dedicated (8 → 3 connections).

## Deferred — need an architecture/maintainer decision

- **Law-pack fixture role_class basis** (`governance/law-pack-validate.ts`): the
  `proposal_tally` fixture harness always tallies over `fixture.eligibleCount`
  rather than recomputing the role_class basis (signer set) like the runtime. A
  direct runtime-mirror was attempted and REVERTED — the existing fixture corpus
  encodes the basis population IN `eligibleCount` (and counts non-signer votes
  toward quorum), so mirroring the runtime broke passing fixtures
  (`capped_grant passes majority` → quorum_not_met). A proper fix must reconcile
  the fixture-authoring convention with the runtime basis (likely a fixture-schema
  change), not just the harness.

- **MFCI cheap-intake attribution** (`invariants/services.ts`): the window-global
  concentration statistic is attributed to the flagged item and pinned at `high`.
  Per the maintainer, the `Math.max` pin is intentional/conservative; the
  attribution question needs the MFCI spec definition to adjudicate.

## Low — redundancy / feature completeness (FIXED)

- **Feature-flags jurisdiction-disable** — DONE. `useFeatureFlagsRefresh` (mounted
  at the app root) runs an always-fresh flags query (`cachePolicy.featureFlags`,
  refetch on focus/reconnect) that re-hydrates the store, so a §21.3 server-side
  disable takes effect without a reload; it fails closed on error.
- **Room-governance link** — DONE. The broken standalone `/rooms/:id/governance`
  text link (a member-duplicate of the governance button, a no-op for non-members)
  was removed; the compact governance button in the membership row is the single
  entry point, and the legacy route still redirects for bookmarked URLs.

## Component wire-ups (SPEC affordances defined but never mounted)

Maintainer decision: wire them up, do NOT delete SPEC features.

DONE this pass:
- **OfflineState** (WS-B.2.5) — mounted in the root shell via `useOnlineStatus`.
- **i18n catalog wiring** (WS-B.2.14/WS-N.1.2b) — `LocalizedI18nProvider` resolves
  `navigator.language` + lazily loads the catalog (German now reachable).
- **SectionEndpoint** (WS-B.2.8a) — mounted at the front-page feed end.
- **FocusModeToggle** (WS-B.2.8c) — profile now uses the component (inline dup removed).
- Dead wallet-api duplicates + dead `setSessionCookie` removed.

DONE (second pass):
- **AiLabel** provenance badge (WS-K §24.1/§24.3) — i18n-ified (`ai.label.*` keys,
  English defaults) and mounted on `TranslationDisclosure` (SSOT `AI-translated`
  badge) and the debate `VerdictPanel` (machine-generated rationale). NOT mounted
  on the story `body_summary` (no provenance field distinguishes an AI summary
  from a user's own brief — labeling it would risk mislabeling authored content;
  needs a server summary-provenance field first).
- **DisabledFeatureExplanation** (WS-N §17.10) — wired on the wallet page via
  `useFeatureAvailabilityQuery` (the `/v1/compliance/availability` endpoint already
  carries `disable_reason` + `region`), so a locked wallet shows the concrete
  reason + next step.

REMAINING (each needs more than a trivial mount — do as a focused follow-up):
- **BlockMuteButtons** (WS-J.1.2): the server block/mute requires a stable
  `blocked_user_id` (self-block guarded), but the public comment payload exposes
  only a HANDLE by identity-minimization design — no user-id. Mounting on comments
  therefore needs a HANDLE-based block/mute API (server resolves handle→id at
  block time, storing the stable id) so no user-id is leaked on every comment;
  that is a block-model design decision (mutable-handle semantics), NOT a trivial
  mount. Block/mute remain reachable via the safety settings page meanwhile.
- **SwipeableStoryCard** + `useStoryCardSwipe` (WS-B.2.2 gestures), **SourceReader
  reader-mode** (its sole caller passes no source HTML — needs the source-HTML
  fetch), **VoiceDictation** (pick one of the two impls, mount in the composer),
  **ComposerAffordances** (Attachment/CitationCapture/PrivacyWarning), and the
  **ScrollArea/SafeArea** primitives + **jargon** plain-language audit — larger UI
  integrations.
