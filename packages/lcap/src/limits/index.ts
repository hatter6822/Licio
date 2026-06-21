// SPDX-License-Identifier: AGPL-3.0-or-later
export {
  type CapCheck,
  type CapName,
  type CapProfile,
  capsForProfile,
  checkCap,
  clampCaps,
  enforceCap,
  OLD_PHONE_CAPS,
  type ResourceCaps,
  ResourceLimitError,
  SERVER_CAPS,
} from './caps.js';
export {
  checkDependencyGraph,
  DEFAULT_GRAPH_LIMITS,
  type ExportAudience,
  type GraphGuardContext,
  type GraphGuardLimits,
  type GraphGuardNode,
  type GraphGuardResult,
  type GraphRejectionCode,
  graphLimitsFromCaps,
} from './graph-guard.js';
export {
  type AdmissionDecision,
  type AdmissionReason,
  type AdmissionRequest,
  admitRelayObject,
  DEFAULT_RELAY_QUOTA,
  type RelayQuotaConfig,
  type RelayUsage,
} from './relay-quota.js';
