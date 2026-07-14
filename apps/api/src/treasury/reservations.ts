// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.2.3a/a-1 — spend-cap enforcement backed by the reservation sub-ledger.
// Headroom for a new spend = law-pack per-window cap − consumed − reserved,
// all in exact decimal math.  A reservation is created when a spend proposal
// is APPROVED (one per proposal — the unique index makes double-approval a
// collision, not a double-count), consumed atomically at execution, and
// released on expiry/rejection/revert/upheld-challenge (idempotent CAS
// transitions).  The KERNEL remains the final enforcement point at execution
// (per-action + per-window caps re-checked there); this ledger closes the
// concurrent-approval TOCTOU the kernel alone cannot see.

import { decCompare, decSum, type TreasuryBounds } from '@licio/governance';
import { type TreasuryGovernanceError, tgErr } from './profile.js';
import type { ReservationRecord, ReservationStore } from './stores.js';

export interface ReservationDeps {
  reservations: ReservationStore;
  now: () => number;
  uuid: () => string;
}

/** Exact non-negative subtraction (floored at zero). */
function decSubFloor(a: string, b: string): string {
  const diff = decSum([a, `-${b}`]);
  return diff.startsWith('-') ? '0' : diff;
}

export interface HeadroomResult {
  cap: string;
  consumed: string;
  reserved: string;
  headroom: string;
}

/** `cap − consumed − reserved` for one (treasury, category), exact decimal. */
export async function categoryHeadroom(
  deps: ReservationDeps,
  treasuryId: string,
  category: string,
  bounds: TreasuryBounds,
): Promise<HeadroomResult | null> {
  const cap = bounds.caps.find((c) => c.category === category);
  if (!cap) return null;
  const reservedRows = await deps.reservations.listActiveByTreasury(treasuryId, category);
  const consumedRows = await deps.reservations.listConsumedByTreasury(treasuryId, category);
  // Consumed within the CURRENT rolling window only (mirrors the kernel).
  const windowStart = deps.now() - cap.windowSeconds * 1000;
  const consumed = decSum(
    consumedRows.filter((r) => Date.parse(r.updatedAt) >= windowStart).map((r) => r.amount),
  );
  const reserved = decSum(reservedRows.map((r) => r.amount));
  const capMax = typeof cap.perWindowMax === 'number' ? String(cap.perWindowMax) : cap.perWindowMax;
  const headroom = decSubFloor(decSubFloor(capMax, consumed), reserved);
  return { cap: capMax, consumed, reserved, headroom };
}

export interface ReserveInput {
  treasuryId: string;
  proposalId: string;
  category: string;
  asset: string;
  amount: string;
  bounds: TreasuryBounds;
}

/**
 * Reserve an approved proposal's amount against its category cap
 * (WS-M.2.3a-1).  Rejects when the amount exceeds the remaining headroom or
 * the per-action cap; a duplicate approval collides on the one-per-proposal
 * unique and returns the EXISTING reservation (idempotent).
 */
export async function reserveForProposal(
  deps: ReservationDeps,
  input: ReserveInput,
): Promise<TreasuryGovernanceError | { ok: true; reservation: ReservationRecord }> {
  const cap = input.bounds.caps.find((c) => c.category === input.category);
  if (!cap) {
    return tgErr(409, 'no_cap_configured', `No spend cap configured for "${input.category}".`);
  }
  const perAction =
    typeof cap.perActionMax === 'number' ? String(cap.perActionMax) : cap.perActionMax;
  if (decCompare(input.amount, perAction) > 0) {
    return tgErr(
      409,
      'per_action_cap_exceeded',
      `Amount ${input.amount} exceeds the per-action cap ${perAction}.`,
    );
  }
  const headroom = await categoryHeadroom(deps, input.treasuryId, input.category, input.bounds);
  if (headroom === null) {
    return tgErr(409, 'no_cap_configured', `No spend cap configured for "${input.category}".`);
  }
  if (decCompare(input.amount, headroom.headroom) > 0) {
    return tgErr(
      409,
      'per_window_cap_exceeded',
      `Amount ${input.amount} exceeds the remaining headroom ${headroom.headroom} ` +
        `(cap ${headroom.cap}, consumed ${headroom.consumed}, reserved ${headroom.reserved}).`,
    );
  }
  const nowIso = new Date(deps.now()).toISOString();
  const record: ReservationRecord = {
    reservationId: deps.uuid(),
    treasuryId: input.treasuryId,
    proposalId: input.proposalId,
    category: input.category,
    asset: input.asset,
    amount: input.amount,
    state: 'reserved',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const inserted = await deps.reservations.insert(record);
  if (inserted === null) {
    // One reservation per proposal: a racing double-approval lands here.
    const existing = await deps.reservations.getByProposal(input.proposalId);
    if (existing !== null) return { ok: true, reservation: existing };
    return tgErr(409, 'reservation_contended', 'The reservation ledger is busy; retry.');
  }
  return { ok: true, reservation: inserted };
}

/** Execution consumed the reservation (idempotent CAS; false ⇒ already moved). */
export async function consumeReservation(
  deps: ReservationDeps,
  proposalId: string,
): Promise<boolean> {
  const reservation = await deps.reservations.getByProposal(proposalId);
  if (reservation === null) return false;
  if (reservation.state === 'consumed') return true; // idempotent re-drive
  return deps.reservations.transition(
    reservation.reservationId,
    'reserved',
    'consumed',
    new Date(deps.now()).toISOString(),
  );
}

/** Expiry/rejection/revert/upheld-challenge releases the headroom (idempotent). */
export async function releaseReservation(
  deps: ReservationDeps,
  proposalId: string,
): Promise<boolean> {
  const reservation = await deps.reservations.getByProposal(proposalId);
  if (reservation === null) return false;
  if (reservation.state === 'released') return true; // idempotent (reorg replay safe)
  return deps.reservations.transition(
    reservation.reservationId,
    reservation.state === 'consumed' ? 'consumed' : 'reserved',
    'released',
    new Date(deps.now()).toISOString(),
  );
}
