// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The WS-R.18.3 deterministic network simulator (OFFLINE_SPEC §32.3).  Test-support
// only — NOT part of the @licio/lcap public protocol surface, so it is intentionally
// absent from the package barrel; the simulation suite imports it directly.
export type {
  ArrivalEvent,
  ContactSpec,
  LinkModel,
  NodeBehavior,
  SimNodeSpec,
  SimObject,
  SimResult,
  SimScenario,
} from './engine.js';
export { run } from './engine.js';
export {
  allHold,
  forkDetectionContact,
  mediaBeatingP0,
  quarantineRatio,
} from './metrics.js';
export { makePrng, type Prng } from './prng.js';
export {
  allMediaFlood,
  equivocationFork,
  manualFerry,
  quarantineThenClear,
  withholdingRelay,
} from './scenarios.js';
