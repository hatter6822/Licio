// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Device-sequence chain + local capability consumption (OFFLINE_SPEC §11.4,
// §12.2, WS-R.1.3).  `device_seq` is a SINGLE monotonic counter per
// `device_key_id`, global across all that device's capabilities and rooms — it
// makes the device's signing history a verifiable hash chain (each record after
// the first references `prev_device_record_cid`).  Quota accounting is
// independent of the sequence: each accepted record debits its `capability_cid`,
// so records authorized by different capabilities may interleave in one
// sequence.  Local consumption is ADVISORY; the server enforces final usage
// independently (WS-R.12.3).

import type { CapabilityRecordV2 } from '../schemas/records.js';

/** The next sequence slot for a device's signing chain. */
export interface NextSequence {
  readonly deviceSeq: number;
  /** The previous record's CID to chain from (absent for the first record). */
  readonly prevDeviceRecordCid?: string;
}

/**
 * Tracks the per-`device_key_id` signing chain so successive offline records are
 * monotone and hash-linked.  `peekNext` returns the slot to sign into;
 * `commit` advances the chain once the record's `record_cid` is known.
 */
export class DeviceSequenceChain {
  private readonly heads = new Map<string, { seq: number; recordCid: string }>();

  /** The slot the next record for `deviceKeyId` must occupy. */
  peekNext(deviceKeyId: string): NextSequence {
    const head = this.heads.get(deviceKeyId);
    if (!head) return { deviceSeq: 0 };
    return { deviceSeq: head.seq + 1, prevDeviceRecordCid: head.recordCid };
  }

  /**
   * Record that `deviceKeyId` signed `recordCid` at `deviceSeq`, advancing the
   * chain.  Rejects a non-monotone commit (a sequence not exactly one past the
   * head, or a re-commit at/below the head) so the chain cannot silently fork
   * locally.
   */
  commit(deviceKeyId: string, deviceSeq: number, recordCid: string): void {
    const head = this.heads.get(deviceKeyId);
    const expected = head ? head.seq + 1 : 0;
    if (deviceSeq !== expected) {
      throw new Error(
        `non-monotone device_seq for ${deviceKeyId}: got ${deviceSeq}, expected ${expected}`,
      );
    }
    this.heads.set(deviceKeyId, { seq: deviceSeq, recordCid });
  }

  /** The current head sequence for a device, or `-1` if it has signed nothing. */
  headSeq(deviceKeyId: string): number {
    return this.heads.get(deviceKeyId)?.seq ?? -1;
  }
}

/** Per-capability usage accumulated locally before signing offline records. */
export interface CapabilityUsage {
  readonly events: number;
  readonly totalBytes: number;
  readonly mediaBytes: number;
}

const ZERO_USAGE: CapabilityUsage = { events: 0, totalBytes: 0, mediaBytes: 0 };

export type QuotaReason =
  | 'max_single_event_bytes'
  | 'max_offline_events'
  | 'max_total_payload_bytes'
  | 'max_media_bytes';

export type ConsumeResult =
  | { readonly ok: true; readonly usage: CapabilityUsage }
  | { readonly ok: false; readonly reason: QuotaReason };

/**
 * Local capability-usage accounting keyed by `capability_cid`.  `consume` debits
 * one event plus its byte costs against the capability's quotas, returning the
 * first quota violated (without mutating state) or the new usage on success.
 */
export class CapabilityUsageTracker {
  private readonly usage = new Map<string, CapabilityUsage>();

  current(capabilityCid: string): CapabilityUsage {
    return this.usage.get(capabilityCid) ?? ZERO_USAGE;
  }

  consume(
    capabilityCid: string,
    quotas: CapabilityRecordV2['quotas'],
    eventBytes: number,
    mediaBytes: number,
  ): ConsumeResult {
    if (eventBytes > quotas.max_single_event_bytes) {
      return { ok: false, reason: 'max_single_event_bytes' };
    }
    const prev = this.current(capabilityCid);
    const next: CapabilityUsage = {
      events: prev.events + 1,
      totalBytes: prev.totalBytes + eventBytes,
      mediaBytes: prev.mediaBytes + mediaBytes,
    };
    if (next.events > quotas.max_offline_events) return { ok: false, reason: 'max_offline_events' };
    if (next.totalBytes > quotas.max_total_payload_bytes) {
      return { ok: false, reason: 'max_total_payload_bytes' };
    }
    if (next.mediaBytes > quotas.max_media_bytes) return { ok: false, reason: 'max_media_bytes' };
    this.usage.set(capabilityCid, next);
    return { ok: true, usage: next };
  }
}
