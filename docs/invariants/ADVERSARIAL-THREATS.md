# Adversarial threat catalog — the invariant ensemble

The Licio invariants are **open source**: an attacker can read every formula,
threshold, and seed. This is the correct posture (Kerckhoffs's principle —
security must not depend on secrecy of the design), and the project's chosen
operating posture is **fully public, no secrets**: every threshold and seed is
public and deterministic. Defense therefore does **not** rest on hiding
anything. It rests on four structural properties, all exercised by the
ensemble adversarial suite (`apps/api/src/__tests__/invariants-ensemble-adversarial.test.ts`):

1. **Ensemble correlation.** The invariants measure *orthogonal facets* of the
   same attack. Engineering around one usually trips another, because the
   facets are contradictory (you cannot be non-redundant *and* coordinated).
2. **Threshold-hugging is itself anomalous.** Clustering just under a known
   public cliff is a detectable distributional signature that routes the
   attacker into the exact (calibration-independent) MFCI fiber test.
3. **Calibration anti-poisoning.** The MFCI cheap path cannot be desensitized
   by drip-fed coordination; the exact fiber test is the authoritative backstop.
4. **Economic cost.** Account-age / progressive-trust weighting and
   participation-weighted attention make disposable-account attacks expensive.

This document is the **attack catalog**: each entry names an attack, the
invariant it primarily targets, *the cross-invariant that catches the
evasion*, the seeding strategy used to simulate it, and the expected detection.
Each catalog entry has a corresponding scenario in the ensemble suite. The
goal of the suite is to answer one question concretely: **can an attacker who
knows everything about the algorithms still win?** — by proving that the
*combined* system flags each attack even when its primary target is
individually fooled.

> Scope note. The invariants run **shadow-only** until promoted (WS-H.1.2e);
> "detection" here means the shadow signal fires and (where applicable) an
> analyst case opens — never an automated punishment. Consequential actions
> always pass a human (WS-J). The catalog measures *triage power*, not autonomy.

## Per-attack template

Every entry uses this fixed shape:

- **Description** — what the attacker does.
- **Primary target** — the invariant they are trying to fool.
- **Evasion → caught by** — how a sophisticated attacker evades the primary
  invariant, and which *other* invariant catches the evasion.
- **Seeding** — how the ensemble suite simulates it.
- **Expected detection** — the assertion(s) the suite makes.

---

## 1. Sybil brigade (coordinated amplification)

- **Description.** Many freshly created accounts converge on one target to
  manufacture the appearance of organic attention.
- **Primary target.** MFCI (coordination detection on the action table).
- **Evasion → caught by.** A patient attacker spreads the brigade across time
  and accounts to keep each per-window margin near the organic base rate
  (sitting in the fiber bulk, so MFCI's p̂ stays high) → the **Tropical**
  cascade still sees the synchronized *timing* of the drops, and **Braid** sees
  the manufactured agenda churn. Account-age weighting (PR 5) damps the
  brigade's influence regardless.
- **Seeding.** N backdated-"new" accounts emit attention/contribution events on
  one target within a tight window; a control target receives organic, age-
  diverse activity of similar volume.
- **Expected detection.** MFCI risk state escalates **or** the Tropical→MFCI
  intake hook opens a case; the innocent neighbour target is **not** flagged
  (per-target attribution).

## 2. Paraphrase / near-duplicate flood (redundant exposure)

- **Description.** The same claim is reposted across many shell URLs to inflate
  apparent independent coverage (and thus MERI exposure / "Well-Sourced").
- **Primary target.** MERI (the partition-matroid exposure rank).
- **Evasion → caught by.** Exact-URL dedup is trivially evaded with distinct
  URLs → MERI's **near-duplicate** class (MinHash/LSH) collapses lexical
  paraphrases; a *semantic* paraphrase that beats MinHash is collapsed by the
  **embedding-cosine** independence signal (PR 4, when a semantic provider is
  deployed); and the shared **claim / source-lineage / evidence** classes bound
  exposure even when the surface text differs.
- **Seeding.** One canonical story plus K near-identical reposts (shared
  MinHash signature and/or shared claim/lineage group); a genuinely independent
  corroboration as a control.
- **Expected detection.** MERI marginal gain for the reposts is ≤ the
  syndication epsilon (folded into "more on this story"); the independent
  corroboration retains a full gain.

## 3. Threshold-hugging (operating-point gaming)

- **Description.** Knowing the exact public threshold, the attacker tunes
  activity to sit *just under* it — paraphrasing to Jaccard just below the
  near-dup cutoff, or pacing coordination to keep p̂ just above the risk cliff.
- **Primary target.** Any threshold-bearing invariant (MFCI, SCOI, PHI, the
  visibility boundary).
- **Evasion → caught by.** The clustering of many entities just below a cliff
  is itself a distributional anomaly: the **threshold-hugging meta-signal**
  (PR 2, generalizing Braid's threshold-gaming) flags the sub-threshold mass and
  **routes the flagged targets to the exact MFCI fiber test** (calibration-
  independent), so knowing the threshold becomes a liability rather than an edge.
- **Seeding.** A population of targets whose scores are massed in `[τ−δ, τ)` for
  some invariant's public threshold τ, versus a diffuse control population.
- **Expected detection.** `detectThresholdHugging` flags the population; the
  `invariants.threshold_hugging.detected` metric fires; flagged targets are
  escalated to MFCI intake.

## 4. Synchronized cascade (manufactured "breaking")

- **Description.** Near-identical arrivals from nominally independent sources
  fake an organic breaking-news cascade.
- **Primary target.** Tropical cascade (arrival-time geometry).
- **Evasion → caught by.** Jittering arrival times to blur the synchrony →
  **MFCI** still sees the cross-account target concentration, and **MERI** sees
  the shared claim lineage of the "independent" sources.
- **Seeding.** A burst of source-open / submission events on one topic from
  many accounts within the synchrony window; a control topic with diffuse
  arrivals.
- **Expected detection.** Tropical `detected = true` and the intake hook opens
  an MFCI case; the diffuse control is not flagged ("does not cry wolf").

## 5. Context-collapse exploitation (manufactured "divergence")

- **Description.** An attacker manufactures apparent cross-lens disagreement to
  trigger a "Needs Context" / obstruction signal and suppress a target, or to
  weaponize a context label.
- **Primary target.** SCOI (sheaf obstruction energy).
- **Evasion → caught by.** SCOI **requires a safety signal** before any
  "weaponized" context state — interpretation divergence alone never enforces;
  and manufactured divergence from sock-puppets trips **MFCI** (coordination)
  and **Hodge** (harmful-tension structure) on the same thread.
- **Seeding.** A thread with two opposed lens clusters whose contributions are
  authored by a coordinated set vs. an organically divergent thread.
- **Expected detection.** SCOI reports a non-coherent context state **without**
  a weaponized enforcement (no safety signal); the coordinated variant *also*
  raises MFCI/Hodge.

## 6. Path-steering / rabbit-hole (compulsive-loop manufacturing)

- **Description.** Content engineered to wind a user into a narrow, re-entrant
  topic loop (engagement maximization at the cost of wellbeing).
- **Primary target.** PHI (preference holonomy) / Path-signature wellbeing.
- **Evasion → caught by.** Interleaving benign topics to keep the holonomy loop
  magnitude low → the **re-entry / rapid-return** detector (Path-signature) and
  the narrow-loop session detector still see the compulsive return structure.
- **Seeding.** A privacy-preserving session sequence with a re-entrant topic
  loop vs. a genuinely diverse session.
- **Expected detection.** PHI non-zero holonomy **or** Path-signature classifies
  the session as a narrow loop; the diverse session classifies as healthy.

## 7. Bias / fairness evasion (attribute-correlated ranking)

- **Description.** A ranking that advantages content along a protected attribute
  (locale, tenure) while appearing attribute-blind.
- **Primary target.** CID (counterfactual invariance defect).
- **Evasion → caught by.** Hiding the bias behind a proxy feature → CID measures
  defect over the **verified permutation group** (attribute-agnostic, not just a
  single-attribute blind), and **GWEI** catches the experience disparity between
  cohorts as a relational-structure divergence.
- **Seeding.** A synthetic ranker that is locale-biased vs. a locale-blind one;
  two cohorts with the same relational structure but different members.
- **Expected detection.** CID > 0 for the biased ranker (0 for the blind one);
  GWEI flags the degraded cohort and the release gate blocks it.

## 8. Coordinated-report abuse (brigaded moderation)

- **Description.** A brigade mass-reports a target to manufacture a safety
  freeze or suppress a legitimate contributor.
- **Primary target.** The moderation intake / safety state.
- **Evasion → caught by.** Reports are coordinated, so **MFCI** flags the
  reporter concentration (the same fiber test, applied to report actions), and
  **Hodge** sees the harmful-tension structure; the accusation classifier
  requires sourced evidence, so source-free accusation cascades are frozen at
  the PWAtt boundary (WS-E.2.2). The exact fiber test clears false positives.
- **Seeding.** A coordinated set of reports on one target vs. organically
  diverse reports.
- **Expected detection.** MFCI flags the coordinated reporters; the analyst case
  carries the conditioning margins for human clearance.

## 9. Ensemble evasion (multi-front bypass)

- **Description.** The sophisticated end state: an attacker who has studied
  *every* invariant attempts to satisfy all of them simultaneously — non-
  redundant content, age-diverse accounts, jittered timing, benign-interleaved
  sessions.
- **Primary target.** The whole ensemble.
- **Evasion → caught by.** The facets are **contradictory**: to be non-redundant
  (evade MERI) the attacker must author genuinely distinct content (which costs
  real effort and dilutes the coordinated signal); to evade MFCI's timing they
  must desynchronize (which defeats the cascade they wanted); to evade the
  threshold-hugging meta-signal they must not cluster near the cliff (which
  forfeits the precision that made the attack cheap). The remaining residual is
  *expensive, multi-front, and human-detectable* — the realistic security goal.
- **Seeding.** A composite scenario combining the evasions above.
- **Expected detection.** At least one invariant fires on each composite; the
  suite asserts that no single evasion zeroes the ensemble.

---

## How the suite is run

- **Named gate.** `pnpm check:adversarial` runs the ensemble spec; it is a CI
  step alongside `check:neutrality`.
- **Determinism.** Pure-math attack generators live in
  `packages/invariants/src/platform/synthetic.ts` and are pinned in the
  regression harness (`regression.ts`), so evasion attempts are regression-
  guarded across seeds.
- **Growth.** Each hardening PR (the threshold-hugging meta-signal, the MFCI
  calibration anti-poisoning, the MERI semantic independence signal, and the
  account-age weighting) adds the scenario its defense makes pass, so the
  catalog and the suite grow together.

## Honest limits

Nothing here makes an invariant unbeatable. The realistic goal is to make a
successful attack **expensive, multi-front, and human-detectable** so the
attacker's ROI goes negative. Calibration poisoning and (when a learned
component is deployed) training poisoning are ongoing arms races that need
monitoring, not a one-time patch — which is why the calibration anti-poisoning
defense emits drift alerts rather than assuming a fixed baseline.
