# DEVELOPMENT.md — running Licio locally for user testing

This guide is for developers and **user-testers** who want to run Licio on
their own machine and click through the whole product. It covers the
zero-setup dev server, the seeded test accounts and how to sign in
(Licio is passwordless), and what the development seed populates so you can
see every surface — including how the mathematical invariants behave.

For engineering conventions and the architecture, see `CLAUDE.md`; for the
design specification, see `docs/SPEC.md`.

---

## 1. Quick start

```bash
# Prerequisites: Node 22+ (pinned in .nvmrc), pnpm 9.15.4+.
corepack enable && corepack prepare pnpm@9.15.4 --activate
pnpm install

# Start the web app (http://localhost:5173) + the API (http://localhost:3001).
pnpm dev
```

`pnpm dev` runs **entirely in-memory** — no PostgreSQL, no Redis, no external
services. On boot it seeds a rich demo corpus (rooms, stories, threads,
evidence, invariant signals, and reading signals) through the *real*
production stores and read paths, so what you see is what the production code
renders, just with development data.

> **The in-memory stores are ephemeral.** Every restart starts from a clean
> seed. Anything you create in a session is lost on restart — that is by
> design for a throwaway dev box. To run against durable Postgres/Redis, set
> `DATABASE_URL` and `REDIS_URL` (see `.env.example`) and run `pnpm db:migrate`.

Ports: web `5173`, API `3001`. The web app proxies API calls, so you only
need to open **http://localhost:5173**.

---

## 2. Test accounts and how to sign in

Licio is **passwordless by design** — there is no password field anywhere.
Real users sign in with a passkey (WebAuthn), a one-time email code, or (for
adults) Sign-In with Ethereum. Passkeys are bound to a physical device and
cannot be pre-seeded, so the development accounts below sign in with the
**email one-time code**.

### 2.1 The seeded accounts

| Role chip | Display name      | Email                 | What it exercises |
|-----------|-------------------|-----------------------|-------------------|
| **admin** | Ada Admin         | `admin@licio.test`    | Full RBAC: every steward **and** admin surface. |
| **steward** | Sam Steward     | `steward@licio.test`  | The WS-J doctrine steward roles `ROLE_SAFETY` + `ROLE_APPEALS` + `ROLE_INTEGRITY` — the report-queue, appeals, and integrity (coordinated-report incident) console tabs; governance; ranking/audit reads. |
| **expert** | Dr. Erin Expert  | `expert@licio.test`   | The platform `expert` role (least-privilege): may post top-level in expert-gated rooms (e.g. *Open Science*) where ordinary members cannot — but holds no moderation/admin power. |

There is also a plain demo author, `demo@…`-less `licio_demo`, that owns most
of the seeded content. The three accounts above are the ones to test *roles*
with.

> The `.test` top-level domain is reserved (RFC 6761) and is never deliverable —
> these addresses are unambiguously fake.

### 2.2 Signing in (email one-time code)

Because there is no mail server in development, the one-time code is **printed
to the API server log** (the terminal running `pnpm dev`). The dev mailer is
the only place this happens, and only when `NODE_ENV=development`.

1. Open **http://localhost:5173** and go to **Sign in**.
2. Choose **email**, enter one of the addresses above (e.g. `admin@licio.test`),
   and submit.
3. Look at the `pnpm dev` terminal for an `auth.mail.dev_code` log line like:

   ```
   INFO: auth.mail.dev_code
       to: "admin@licio.test"
       kind: "login"
       code: "Y3A2KY5D"
   ```

   The 8-character `code` is your one-time code.
4. Enter the code in the app. You are now signed in as that account.

The code is single-use, expires in 10 minutes, and is bound to the browser
that requested it. The seeded accounts already have a **verified** email, so
verified-only surfaces (e.g. privacy settings) work on first sign-in.

### 2.3 Steward/admin surfaces and step-up MFA

Some steward/admin actions require **step-up MFA** (TOTP). Email-OTP sign-in
gives you an ordinary (non-MFA) session, so when you hit a step-up-gated
action you will be prompted to verify. In development you can enrol an
authenticator on the **Profile → Security** page (the dev build also exposes a
"mark verified" helper, gated to dev builds and a fail-closed
`NODE_ENV` allowlist on the server). We deliberately do **not** pre-seed a TOTP
secret — a known shared secret would be a security smell even in development.

---

## 3. What the development seed populates

The seed (`apps/api/src/lib/demo-seed.ts`, dev-only) builds a corpus designed
so that **every** reader-facing surface and **every** invariant signal has
something to show.

### 3.1 Rooms and content

- **Public topic rooms** (Public Health, Climate & Energy, Elections &
  Governance), **local rooms** (Riverside, Harbor District), an **expert-gated**
  public room (Open Science — only experts/stewards may post top-level), and
  **private rooms** (Transit Working Group, Newsroom Desk, Budget Review) with
  request-to-join and invite join models.
- **Stories of varied §14.1 submission types** (link, original brief, question,
  local update, and a **native image post** with a real served PNG) across the
  **public** and **`room_only`** visibility tiers. (Video posts are best tested
  live via the composer — sign in and upload one.)
- **Threads with nested, multi-author contributions** spanning the contribution
  taxonomy (questions, answers, evidence, corrections, counterexamples,
  syntheses, local context, direct experience, …), plus community syntheses.
- **A non-empty moderation review queue** (pending `moderation_concern` items
  with ratified reason codes) for the steward/admin review surface.
- **A WS-J report case** (two reporters → one standard case in the moderation
  console's report queue) so the steward/admin console renders real data — the
  full-context review panel, the action palette, and the audit log — on first
  boot.

### 3.2 The seven rating labels

Rating labels describe **conversation state**, never popularity (SPEC §5.6).
The seed places stories in varied lifecycle states and attaches live signals so
that **all seven** labels appear in the feed:

| Label | How the seed produces it |
|-------|--------------------------|
| Getting Attention | A freshly gathering story (the default). |
| Deepening | A story in the `deepening` lifecycle state. |
| Well-Sourced | ≥2 independent evidence cards **and** a MERI independence signal. |
| Needs Context | Divergent lens interpretations (SCOI) / `context_needed`. |
| Under Review | A thread placed under safety review (descriptive, not a sanction). |
| Resolved Context | A `stable` story with a high-quality synthesis. |
| Bridge Active | A `bridging` story reconciling two communities. |

> If you previously saw **every** story labelled "Getting Attention", that was
> the symptom of two now-fixed issues: every seeded story was created in the
> same lifecycle state, and two of the seven labels had no producer at all.

### 3.3 Invariant signals you can see

These are **computed**, not hand-authored: the seed runs the real WS-H invariant
batch over the shaped content (and the real WS-E PWAtt scorer for §3.4), so the
signals are exactly what production produces.

- **MERI exposure labels** ("independent source", "duplicate context", …) on
  feed cards and in the **independent-sources drawer**. A verbatim repost is
  computed as a *duplicate* exposure, and the drawer lists it as a
  near-duplicate co-member — ten reposts never count as ten (SPEC §7.1).
- **SCOI divergence** in the **"Where interpretations differ"** drawer, driven
  by two lenses (skeptical vs industry) whose contributions genuinely read a
  story differently.
- **Safety posture** (`caution` / `under review`) surfaced descriptively on the
  affected threads.

MERI runs at *honestly limited coverage* here because most demo stories are
briefs/questions without full source/claim/evidence metadata — that is graceful
degradation, not a failure: the exposure signal is still computed and the
well-sourced stories come out independent. The hourly schedulers recompute from
the same content as you interact.

### 3.4 Reading signals (your Signal Ledger)

**Profile → Signal Ledger** shows *your own* bounded attention record —
coarse buckets only (active-dwell bucket, source/context opened, branch depth,
return-visit bucket), never raw traces, never anyone else's. The seed feeds
bucketed attention aggregates for the test accounts through the **real PWAtt
scorer** (the same engine production uses), so the ledger you see on first
sign-in was *produced* by the scorer, not written by hand; as you read stories,
the in-browser pipeline adds more.

---

## 4. Useful commands

```bash
pnpm dev                 # web (5173) + api (3001), in-memory + seeded
pnpm build               # production build of every workspace
pnpm test                # Vitest across all workspaces (80% coverage gate)
pnpm typecheck           # strict TypeScript across all workspaces
pnpm lint                # Biome format + lint
pnpm check:neutrality    # the ranking-neutrality gate
pnpm check:no-applause   # no likes/votes/karma/reactions
pnpm check:no-raw-egress # no raw attention traces leaving the browser
```

Run a single workspace's tests with `pnpm --filter <web|api|@licio/shared|…>
test`. The mathematical invariants have a dedicated suite:
`pnpm --filter @licio/invariants test`.

---

## 5. Security notes for the dev environment

- The development conveniences (the dev mailer that surfaces OTP codes, the
  "mark verified" helper, the relaxed account-age gate for submissions) are
  **fail-closed**: each is allow-listed to `NODE_ENV` development/test on the
  server and reads as `404`/disabled in any deployed, staging, or
  `NODE_ENV`-unset build. None of them can become a production backdoor.
- No password or shared secret is seeded anywhere. The test accounts are
  ordinary passwordless accounts; their only "credential" is the ability to
  receive the OTP code, which in development is surfaced to the local API log.
- The seed never runs when `NODE_ENV=production`.
