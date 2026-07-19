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

- **`/api/csrf-token` unbounded store writes** (`middleware/csrf.ts`): forged
  session cookies mint TTL-bounded token entries. A clean app-level fix needs
  session validation wired into the base-app CSRF route (layering) or a global
  rate limit (would throttle legit high-frequency token fetches); the doctrine
  delegates connection-level flooding to the edge, and the tokens are worthless to
  the attacker. Decide the approach.
- **Live volume-trigger threshold** (`events/consumers.ts`): the runtime-tunable
  `trigger_threshold` is captured at boot, so live tuning needs a restart. A live
  fix needs a shared config cache between the pwatt scheduler and the consumer.
- **Cross-surface replay nonce TTL** (`events/ingest.ts`): the replay nonce TTL is
  sized to the CURRENT request's policy, so an online-ingested event's short nonce
  can expire before an offline 7-day-window re-ingest. Size the nonce to the MAX
  window across surfaces (needs a max-window constant / policy review).
- **ioredis connection consolidation** (`index.ts`): the prod boot opens ~8
  connections where one shared client + dedicated subscribers suffice — a boot
  refactor.
- **MFCI cheap-intake attribution** (`invariants/services.ts`): the window-global
  concentration statistic is attributed to the flagged item and pinned at `high`.
  Per the maintainer, the `Math.max` pin is intentional/conservative; the
  attribution question needs the MFCI spec definition to adjudicate.

## Low — redundancy / feature completeness

- **Feature-flags jurisdiction-disable** (`stores/feature-flags.ts`,
  `lib/query-client.ts`): the documented §21.3 jurisdiction-disable actions are
  never dispatched and the `featureFlags` cache policy/queryKey are unused (no
  always-fresh flags query). Wire the flags query or remove the dead policy.
- **Room-governance link** (`routes/-pages/rooms.tsx`): the link routes through the
  legacy redirect and is a silent no-op for non-members — route it to the room
  governance deep link (or hide it for non-members).

## Component wire-ups (SPEC affordances defined but never mounted)

Maintainer decision: wire them up, do NOT delete SPEC features.

DONE this pass:
- **OfflineState** (WS-B.2.5) — mounted in the root shell via `useOnlineStatus`.
- **i18n catalog wiring** (WS-B.2.14/WS-N.1.2b) — `LocalizedI18nProvider` resolves
  `navigator.language` + lazily loads the catalog (German now reachable).
- **SectionEndpoint** (WS-B.2.8a) — mounted at the front-page feed end.
- **FocusModeToggle** (WS-B.2.8c) — profile now uses the component (inline dup removed).
- Dead wallet-api duplicates + dead `setSessionCookie` removed.

REMAINING (each needs more than a trivial mount — do as a focused follow-up):
- **AiLabel** provenance badge (WS-K §24.1/§24.3): mount on AI artifacts. NOTE:
  `AiLabel` is NOT i18n-aware, so swapping it into `TranslationDisclosure` (which
  has a localized badge) would regress localization — either i18n-ify `AiLabel`
  first (add `useT` + keys for all 7 labels), or mount it on the currently
  un-badged debate `VerdictPanel` with an arena-state→provenance-label mapping.
- **BlockMuteButtons** (WS-J.1.2): mount on the comment author-actions row (next
  to Report) with a self-block guard; `lib/safety-api` createBlock/createMute
  already exist. No new API, but needs UI placement + a self-target guard + tests.
- **DisabledFeatureExplanation** (WS-N §17.10): needs the server to expose a
  per-feature disable REASON (the feature-flags response carries booleans only)
  before the component can replace the generic "wallet unavailable" RestrictedState.
- **SwipeableStoryCard** + `useStoryCardSwipe` (WS-B.2.2 gestures), **SourceReader
  reader-mode** (its sole caller passes no source HTML — needs the source-HTML
  fetch), **VoiceDictation** (pick one of the two impls, mount in the composer),
  **ComposerAffordances** (Attachment/CitationCapture/PrivacyWarning), and the
  **ScrollArea/SafeArea** primitives + **jargon** plain-language audit — larger UI
  integrations.
