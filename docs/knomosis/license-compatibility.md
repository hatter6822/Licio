# Knomosis license compatibility analysis

| | |
|---|---|
| **Task** | WS-L.1.1c (`docs/planning/13-knomosis-and-wallets.md`) |
| **Status** | reviewed draft |
| **Date** | 2026-07-06 |
| **Spec refs** | `docs/SPEC.md` §17.1–17.2 (integration boundaries), §20.4 (licensing posture), §25.6 (Knomosis security, pinning), §30.7 (K0 due-diligence gate: "license/copyleft analysis (AGPL/GPL)") |
| **Review** | This analysis records the engineering position. Per the WS-L.1.1c acceptance criteria it must additionally be reviewed by a team member with licensing expertise or legal counsel before the K2 (testnet gateway) promotion; that sign-off is tracked as residual R3 below. This document is not legal advice. |

## 1. Scope and conclusion

This document analyzes license compatibility between **Licio**
(AGPL-3.0-or-later — root `LICENSE`, root `package.json` `"license"` field,
per-file `SPDX-License-Identifier: AGPL-3.0-or-later` headers) and
**Knomosis** (GPL-3.0-or-later — per the Knomosis repository README recorded
in `docs/SPEC.md` Appendix, reviewed 2026-06-07, version v0.4.11, Lean
toolchain v4.29.1).

**Conclusion.** The pairing is permitted. AGPLv3 and GPLv3 each carry an
explicit section-13 cross-linking provision that allows the two to be
combined into a single work, with each part retaining its own license. In
Licio's actual topology the question is even narrower: no Knomosis source
exists in the Licio tree, and the two systems interact only as separate
processes over the versioned `knomosis-gateway` HTTP contract, which under
FSF guidance does not create a combined work at all. The in-repo integration
code is entirely Licio-authored AGPL. The remaining open item is the
third-party dependency audit of the Knomosis subtree itself, which cannot be
completed until a non-local deployment is pinned (residual R1).

## 2. The two licenses

- **Licio: AGPL-3.0-or-later.** Chosen deliberately (`docs/SPEC.md` §20.4)
  because the PWA and BFF are delivered over a network; plain GPL-3.0 would
  not require sharing modifications with remote users (the network/SaaS
  gap), and AGPL-3.0 §13 closes it. Every source file in the repository
  carries the AGPL SPDX header; the CI security-audit job includes an AGPL
  header check.
- **Knomosis: GPL-3.0-or-later.** The upstream L2 stack (Lean 4 formal
  kernel, Solidity settlement layer, Rust runtime — the four-layer model of
  `docs/SPEC.md` §17.2). Licio consumes it as an external system, not as a
  library.

Both licenses are "-or-later", so a future FSF license revision cannot wedge
the pairing: either side may be taken under a later version if one is ever
needed for compatibility.

## 3. FSF compatibility analysis: the paired section-13 provisions

The FSF license list (gnu.org/licenses/license-list, entry "GNU Affero
General Public License (AGPL) version 3") classifies AGPLv3 as a free
software license and describes its relationship to GPLv3 precisely. Two
points matter and must not be conflated:

1. **Strict-sense compatibility (relicensing) does not hold, and is not
   needed.** Code released under AGPLv3 cannot be conveyed under GPLv3's
   terms, nor vice versa — the FSF license-list entry says so explicitly.
   Neither Licio nor Knomosis relicenses the other's code, so this
   limitation is irrelevant to the integration.
2. **Combination is explicitly permitted, in both directions, by the paired
   section 13 of each license:**
   - **GPLv3 §13** ("Use with the GNU Affero General Public License"):
     "Notwithstanding any other provision of this License, you have
     permission to link or combine any covered work with a work licensed
     under version 3 of the GNU Affero General Public License into a single
     combined work, and to convey the resulting work."
   - **AGPLv3 §13** (second paragraph, "Remote Network Interaction; Use with
     the GNU General Public License"): the mirror-image permission to link
     or combine an AGPL-covered work with a GPLv3-covered work.

   In a combined work, each part continues to be governed by its own
   license, and — per both clauses — "the special requirements of the GNU
   Affero General Public License, section 13, concerning interaction through
   a network will apply to the combination as such." Practically: if Licio
   ever did form a combined work with Knomosis code, the network
   source-availability obligation would extend to the combination. Because
   Licio is already fully AGPL and publicly published, that obligation is
   already discharged; it imposes nothing new.

One asymmetry worth recording: AGPLv3 is **not** compatible with GPLv2-only
(the FSF entry is explicit). Knomosis is GPL-3.0-or-later, so this does not
affect the pairing itself, but it constrains the dependency audit: a
GPL-2.0-**only** dependency anywhere in the combined graph would be an
incompatibility. Section 6 shows the tooling already encodes this
distinction.

## 4. Combined-work topology

The section-13 analysis above is the worst case. The actual topology is
cleaner on three independent grounds, each verifiable in the repository.

### 4.1 No Knomosis source is vendored in the Licio tree

There is no Knomosis submodule, subtree, or copied source anywhere in the
repository. A repository-wide scan for non-AGPL SPDX headers under `apps/`
and `packages/` returns zero matches — every file, including all of the
WS-L integration code, carries `SPDX-License-Identifier:
AGPL-3.0-or-later`. The Knomosis deployment is referenced only by **facts**
(commit hash, contract addresses, manifest hashes, toolchain versions) in
`apps/api/src/knomosis/pin.config.json`, validated fail-closed at boot by
the strict zod schema in `apps/api/src/knomosis/pin.ts`
(`pinConfigSchema` / `parsePinConfig`). Pinning a commit hash is a
provenance record, not a conveyance of GPL code.

### 4.2 Runtime topology: separate processes over a versioned HTTP contract

Licio's BFF talks to the Knomosis runtime exclusively through the
`knomosis-gateway` contract v0.4 (HTTP/JSON + SSE), implemented in
`apps/api/src/knomosis/gateway.ts`:

- `HttpKnomosisGateway` (`gateway.ts` line ~258) is a `fetch`-based client
  against `env.KNOMOSIS_GATEWAY_URL` with file-loaded bearer-token service
  auth, wired in `apps/api/src/index.ts` (the `setServicesGateway(...,
  new HttpKnomosisGateway({ baseUrl: env.KNOMOSIS_GATEWAY_URL, ... }))`
  branch). The gateway process is a separately deployed program.
- All exchange happens over sockets in wire formats validated by
  Licio-authored zod schemas (`gatewayVerdictSchema`, `gatewayEventSchema`,
  the standing-read envelope in the same file).

Under the FSF's own criteria (GPL FAQ, "mere aggregation" /
`MereAggregation`: two programs communicating "at arm's length" through
mechanisms normally used between separate programs — sockets, pipes,
command-line arguments — remain separate works), protocol interaction of
this shape does not create a combined work. Licio and Knomosis are two
programs, each under its own license, exchanging data. No GPL obligation
flows onto Licio from calling the gateway, and no AGPL obligation flows
onto Knomosis from being called.

### 4.3 The in-repo integration code is Licio-authored AGPL

The entire WS-L surface is original Licio code written against public
standards and the gateway's documented wire contract, not derived from
Knomosis sources:

- `apps/api/src/knomosis/` — pin loader, gateway client, wallet linking,
  preflight, submission, ingest, reconciliation, receipts, standing,
  simulation, readiness, kill switch, signature verification
  (`signatures.ts` implements EIP-712/EIP-1271/ECDSA — public Ethereum
  standards), stores and Drizzle adapters.
- `packages/shared/src/knomosis/` (`typed-data.ts`, `preview.ts`,
  `index.ts`) and `packages/shared/src/schemas/{wallet-api,knomosis-api}.ts`
  — typed-data construction and wire contracts.
- `packages/db/src/schema/knomosis-gateway.ts` + migration 0059, and the
  `packages/db/src/isolation.ts` wallet↔ranking isolation guard.
- `FakeKnomosisGateway` (`gateway.ts`) deserves an explicit note: it is a
  deterministic in-memory implementation of the gateway **contract
  semantics** (verdicts, seq ordering, idempotency) written from the
  contract specification for dev and tests. It is not a port of Knomosis
  kernel code; implementing an interface/wire contract does not make it a
  derivative of the GPL implementation.

### 4.4 Worst-case fallback

Even if a future audit concluded that some part of the integration formed a
combined work with GPL code (for example, if a Knomosis-provided client SDK
were ever adopted, or Solidity ABIs copied wholesale were held to be
copyrightable expression), the paired §13 provisions of section 3 make that
combination conveyable, with Licio's parts staying AGPL and the Knomosis
parts staying GPL. There is no topology reachable from the current design
in which the pairing becomes non-compliant; the failure modes are limited to
third-party dependencies (section 6).

## 5. AGPL §13 obligations on Licio itself

AGPLv3 §13's first paragraph (remote network interaction) binds **Licio**:
users interacting with the modified program over a network must be offered
the Corresponding Source. This is discharged structurally — the served PWA,
BFF, and every workspace package are in the public AGPL repository, and
`docs/SPEC.md` §20.4 makes source availability a standing posture rather
than a per-release action. Operators who fork Licio inherit the same
obligation; nothing in the Knomosis integration weakens or complicates it.

Conversely, because Knomosis is GPL (not AGPL), a party running a modified
Knomosis gateway for network callers incurs no copyleft source-offer
obligation from network use alone — GPLv3 obligations attach on conveyance.
Licio's own deployments should nonetheless publish any Knomosis
modifications alongside the pinned commit as a transparency matter; this is
folded into residual R1's deployment-record requirement
(`pin.config.json` → `pinned_knomosis_commit` must point at a public,
buildable commit, per the WS-L.1.1a acceptance criteria).

## 6. Third-party dependencies and the SBOM cross-check

### 6.1 The Licio npm tree (implemented, CI-enforced)

`pnpm sbom` runs `scripts/generate-sbom.ts`, which:

- enumerates the direct production dependencies of `apps/web` and
  `apps/api` and walks the **full transitive closure**
  (`collectTransitiveDeps`), emitting CycloneDX 1.5 (`sbom.cdx.json`);
- classifies every component against the `AGPL_COMPATIBLE_LICENSES`
  allowlist (MIT, MIT-0, ISC, BSD-2/3-Clause, Apache-2.0, CC0-1.0,
  Unlicense, 0BSD, BlueOak-1.0.0, AGPL-3.0-only/or-later,
  GPL-3.0-only/or-later, **GPL-2.0-or-later but not GPL-2.0-only** —
  encoding the GPLv2/AGPLv3 incompatibility from section 3 — LGPL-2.1+/3.0,
  MPL-2.0, WTFPL, Zlib, CC-BY-4.0, Python-2.0), with `OR`-expression
  handling;
- **exits non-zero on any incompatible license** (a hard gate, not a
  warning) and warns loudly on `UNKNOWN`.

The CI security-audit job (`.github/workflows/ci.yml`, `run: pnpm sbom`)
executes this on every PR and uploads `sbom.cdx.json` as a build artifact,
satisfying the "CI SBOM check" leg of the WS-L.1.1c testing criteria for
the Licio side. Note one sharpening tracked as residual R4: `UNKNOWN`
licenses currently warn rather than fail; WS-O.3.2d specifies fail-on-unknown
with a manual-review allowlist.

### 6.2 The Knomosis subtree (tracked residual)

The Knomosis stack is not an npm tree — its dependency surfaces are the
Lean 4 toolchain/Lake packages (kernel), the Solidity compiler and any
contract libraries (settlement), and the cargo graph (Rust runtime). Its
SBOM therefore **cannot** be generated by Licio's `pnpm sbom` and must be
produced in the Knomosis repository with ecosystem-native tooling (e.g.
`cargo cyclonedx` for the runtime; Lake manifest + Foundry/solc inputs
enumerated for the kernel and contracts) at the pinned commit.

The deploy-time cross-check is specified as follows and is **blocked on a
pinned non-local deployment existing** (residual R1):

1. The Knomosis-repo SBOM is generated at exactly
   `pin.config.json.deployments[].pinned_knomosis_commit`.
2. Its components are classified against the same compatibility table as
   `scripts/generate-sbom.ts` (shared allowlist, GPL-2.0-only rejected,
   unknown → manual review under the WS-O.3.2d allowlist mechanism).
3. The result is attached to the deployment record (WS-L.1.1a-1) and
   becomes a promotion gate alongside the cross-stack fixture CI
   (WS-L.1.1d).

Today the only pinned deployment is `environment=local` — the in-memory
`FakeKnomosisGateway` with all-zero sentinel commit/hashes, which
`pin.ts` accepts **only** for `local` (the `superRefine` sentinel rule
fails boot for any testnet/production deployment carrying sentinels). That
fail-closed rule is what makes R1 safe to carry: a real deployment cannot
be pinned without replacing the sentinels, and replacing the sentinels is
the event that triggers the subtree SBOM cross-check.

## 7. Residuals

| ID | Item | Blocking for | Tracking |
|----|------|--------------|----------|
| R1 | Knomosis-subtree SBOM (Lean/Solidity/Rust) generated at the pinned commit + deploy-time cross-check attached to the deployment record; no non-local deployment is pinned yet (`pin.config.json` carries only the sentinel `local` entry) | K2 testnet promotion; hard gate for K4 real funds (`docs/SPEC.md` §17.11) | WS-L.1.1a-1 deployment record + this document |
| R2 | CI mirror of the pin sentinel rule (`scripts/check-knomosis-pins.ts`, referenced from `pin.ts` but not yet landed); until it lands, enforcement is boot-time only via `parsePinConfig` | testnet promotion | WS-L.1.1a follow-up in `docs/planning/13-knomosis-and-wallets.md` |
| R3 | Review of this analysis by a team member with licensing expertise or legal counsel (WS-L.1.1c acceptance criterion) | K2 testnet promotion | WS-L.1.1c |
| R4 | `generate-sbom.ts` fail-on-unknown-license + manual-review allowlist (currently unknown ⇒ warning) | WS-O.3.2d completion | `docs/planning/16-security-and-reliability.md` WS-O.3.2d |

## 8. References

- GNU AGPL-3.0: https://www.gnu.org/licenses/agpl-3.0.html (§13 "Remote
  Network Interaction; Use with the GNU General Public License")
- GNU GPL-3.0: https://www.gnu.org/licenses/gpl-3.0.html (§13 "Use with the
  GNU Affero General Public License")
- FSF license list, AGPLv3 entry (compatibility notes incl. the GPLv2
  incompatibility): https://www.gnu.org/licenses/license-list.html#AGPLv3.0
- GPL FAQ, mere aggregation / arm's-length communication:
  https://www.gnu.org/licenses/gpl-faq.html#MereAggregation
- `docs/SPEC.md` §17.2, §20.4, §25.6, §30.7; `docs/planning/13-knomosis-and-wallets.md` WS-L.1.1c
- Code: `apps/api/src/knomosis/{pin.ts,pin.config.json,gateway.ts}`,
  `apps/api/src/index.ts` (gateway wiring), `scripts/generate-sbom.ts`,
  `.github/workflows/ci.yml` (security-audit job), root `LICENSE`
