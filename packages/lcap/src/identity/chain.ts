// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Identity-chain validation (OFFLINE_SPEC §11.1, §18.3 steps 6-11, WS-R.1.5).
// Given a contribution event and a resolver for its dependencies, this composes:
// load the device certificate + verify its account-authority proof; load the
// cited capability + verify its room-authority proof; check
// operation/scope/room/visibility/policy; then check known revocations.  It
// returns the discharged trust facts, OR a precise `quarantined` with the
// missing dependencies, OR `rejected`/`revoked`.  No transport trust: a present
// dependency is validated cryptographically regardless of how it arrived.

import { operationForEventType } from '../records/contribution.js';
import type { ContributionEventRecordV2 } from '../schemas/records.js';
import {
  type AuthorizationDenial,
  type CapabilityBundle,
  type CapabilityVerifyStatus,
  capabilityAuthorizes,
  verifyCapability,
} from './capability.js';
import { type CertificateBundle, type CertVerifyStatus, verifyDeviceCertificate } from './cert.js';
import type { RevocationIndex, RevokedKind } from './revocation.js';

/** A dependency the validator needs but could not resolve locally. */
export type MissingDependency =
  | { readonly kind: 'device_certificate'; readonly deviceKeyId: string }
  | { readonly kind: 'capability'; readonly cid: string }
  | {
      readonly kind: 'account_authority_key';
      readonly accountId: string;
      readonly accountEpoch: number;
    }
  | { readonly kind: 'room_authority_key'; readonly roomId: string; readonly policyEpoch: number };

/** The trust facts discharged by a fully-validated identity chain. */
export interface AuthorizedFacts {
  readonly accountId: string;
  readonly deviceId: string;
  readonly deviceKeyId: string;
  readonly capabilityId: string;
  readonly roomId: string;
  readonly visibilityScope: ContributionEventRecordV2['visibility_scope'];
  readonly operation: ReturnType<typeof operationForEventType>;
  readonly policyEpoch: number;
}

export type ChainRejection =
  | { readonly stage: 'certificate'; readonly status: CertVerifyStatus }
  | { readonly stage: 'capability'; readonly status: CapabilityVerifyStatus }
  | { readonly stage: 'binding'; readonly detail: 'certificate_binding_mismatch' }
  | { readonly stage: 'authorization'; readonly denial: AuthorizationDenial }
  | {
      readonly stage: 'policy';
      readonly detail: 'policy_epoch_regression' | 'single_event_quota_exceeded';
    };

export type IdentityChainResult =
  | {
      readonly status: 'authorized';
      readonly facts: AuthorizedFacts;
      readonly revocationFrontierStale: boolean;
    }
  | { readonly status: 'quarantined'; readonly missing: readonly MissingDependency[] }
  | { readonly status: 'rejected'; readonly reason: ChainRejection }
  | {
      readonly status: 'revoked';
      readonly target: { readonly kind: RevokedKind; readonly id: string };
      readonly replacementCid?: string;
    };

/** Resolves the dependencies referenced by a contribution's identity chain. */
export interface IdentityChainDeps {
  resolveCertificate(deviceKeyId: string): CertificateBundle | undefined;
  resolveCapability(capabilityCid: string): CapabilityBundle | undefined;
  resolveAccountAuthorityKey(accountId: string, accountEpoch: number): CryptoKey | undefined;
  resolveRoomAuthorityKey(roomId: string, policyEpoch: number): CryptoKey | undefined;
  readonly revocations: RevocationIndex;
}

export interface IdentityChainContext {
  readonly networkId: string;
  readonly nowMs: number;
  /** Reject certificates below this account epoch (rotation floor). */
  readonly minAccountEpoch?: number;
  /** If provided, the record's body size for the single-event quota check. */
  readonly eventBytes?: number;
}

/** Validate the §18.3 steps 6-11 authority chain for a contribution event. */
export async function validateIdentityChain(
  record: ContributionEventRecordV2,
  deps: IdentityChainDeps,
  ctx: IdentityChainContext,
): Promise<IdentityChainResult> {
  const missing: MissingDependency[] = [];
  const operation = operationForEventType(record.event_type);

  // Steps 6-7 — device certificate + its account-authority proof.
  const certBundle = deps.resolveCertificate(record.author_device_key_id);
  if (!certBundle) {
    missing.push({ kind: 'device_certificate', deviceKeyId: record.author_device_key_id });
  } else {
    const authorityKey = deps.resolveAccountAuthorityKey(
      certBundle.certificate.account_id,
      certBundle.certificate.account_epoch,
    );
    if (!authorityKey) {
      missing.push({
        kind: 'account_authority_key',
        accountId: certBundle.certificate.account_id,
        accountEpoch: certBundle.certificate.account_epoch,
      });
    } else {
      const certResult = await verifyDeviceCertificate(certBundle, authorityKey, {
        networkId: ctx.networkId,
        nowMs: ctx.nowMs,
        ...(ctx.minAccountEpoch !== undefined ? { minAccountEpoch: ctx.minAccountEpoch } : {}),
      });
      if (!certResult.ok)
        return { status: 'rejected', reason: { stage: 'certificate', status: certResult.status } };
      if (
        certResult.accountId !== record.author_account_id ||
        certResult.deviceId !== record.author_device_id ||
        certResult.deviceKeyId !== record.author_device_key_id
      ) {
        return {
          status: 'rejected',
          reason: { stage: 'binding', detail: 'certificate_binding_mismatch' },
        };
      }
    }
  }

  // Steps 8-10 — capability, its room-authority proof, and authorization.
  const capBundle = deps.resolveCapability(record.capability_cid);
  if (!capBundle) {
    missing.push({ kind: 'capability', cid: record.capability_cid });
  } else {
    const roomKey = deps.resolveRoomAuthorityKey(
      capBundle.capability.room_id,
      capBundle.capability.policy_epoch,
    );
    if (!roomKey) {
      missing.push({
        kind: 'room_authority_key',
        roomId: capBundle.capability.room_id,
        policyEpoch: capBundle.capability.policy_epoch,
      });
    } else {
      const capResult = await verifyCapability(capBundle, roomKey, {
        networkId: ctx.networkId,
        nowMs: ctx.nowMs,
      });
      if (!capResult.ok)
        return { status: 'rejected', reason: { stage: 'capability', status: capResult.status } };
      const authz = capabilityAuthorizes(capBundle.capability, {
        roomId: record.home_room_id,
        visibilityScope: record.visibility_scope,
        operation,
        subjectAccountId: record.author_account_id,
        subjectDeviceKeyId: record.author_device_key_id,
      });
      if (!authz.ok)
        return { status: 'rejected', reason: { stage: 'authorization', denial: authz.denial } };
      if (record.policy_epoch_claim < capBundle.capability.policy_epoch) {
        return {
          status: 'rejected',
          reason: { stage: 'policy', detail: 'policy_epoch_regression' },
        };
      }
      if (
        ctx.eventBytes !== undefined &&
        ctx.eventBytes > capBundle.capability.quotas.max_single_event_bytes
      ) {
        return {
          status: 'rejected',
          reason: { stage: 'policy', detail: 'single_event_quota_exceeded' },
        };
      }
    }
  }

  // Step 11 — revocations (a revoked device/account/capability is never trusted,
  // even if other dependencies are still missing).
  if (deps.revocations.isRevoked('device', record.author_device_key_id)) {
    const rev = deps.revocations.lookup('device', record.author_device_key_id);
    return {
      status: 'revoked',
      target: { kind: 'device', id: record.author_device_key_id },
      ...(rev?.replacement_cid ? { replacementCid: rev.replacement_cid } : {}),
    };
  }
  if (deps.revocations.isRevoked('account', record.author_account_id)) {
    return { status: 'revoked', target: { kind: 'account', id: record.author_account_id } };
  }
  if (capBundle && deps.revocations.isRevoked('capability', capBundle.capability.capability_id)) {
    return {
      status: 'revoked',
      target: { kind: 'capability', id: capBundle.capability.capability_id },
    };
  }

  if (missing.length > 0) return { status: 'quarantined', missing };

  // All dependencies resolved and valid; the capability is therefore present.
  if (!capBundle)
    return { status: 'quarantined', missing: [{ kind: 'capability', cid: record.capability_cid }] };
  const { capability } = capBundle;
  return {
    status: 'authorized',
    revocationFrontierStale: deps.revocations.knownEpoch < capability.revocation_epoch_floor,
    facts: {
      accountId: record.author_account_id,
      deviceId: record.author_device_id,
      deviceKeyId: record.author_device_key_id,
      capabilityId: capability.capability_id,
      roomId: capability.room_id,
      visibilityScope: record.visibility_scope,
      operation,
      policyEpoch: capability.policy_epoch,
    },
  };
}
