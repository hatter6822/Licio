// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Performance budget enforcement (WS-C.5.1): Core Web Vitals RUM (privacy-safe)
// and User Timing marks for the PWA interaction budgets. The bundle-size gate
// (scripts/check-bundle-size.ts) and lab measurement are the CI release gates.
export {
  INTERACTION_BUDGETS,
  type InteractionName,
  isWithinBudget,
  markInteractionStart,
  measureInteraction,
} from './marks.js';
export { initWebVitals, type Rating, rateMetric, type VitalName, type WebVital } from './vitals.js';
