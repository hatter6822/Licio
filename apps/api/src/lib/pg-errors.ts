// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reading a Postgres constraint failure — ONE implementation.
//
// Drizzle wraps the driver error (`DrizzleQueryError` → `cause: PostgresError`),
// so the SQLSTATE never sits on the error you catch: a direct `.code` check
// silently never fires, and the write that should have been recognised as "this
// already exists" reads as "the store is broken".  The two answers are
// opposite — a 409 that tells the caller to stop, versus a 503 that tells them
// to retry — so getting it wrong is not cosmetic.
//
// That one non-obvious fact was rediscovered and re-encoded in five places
// (`forum/drizzle-debate-store`, `forum/drizzle-forum-stores`,
// `ingestion/drizzle-ingestion-stores`, `knomosis/drizzle-knomosis-stores`, and
// the WS-N policy/disclosure writes), each with its own copy of the same loop
// and its own comment explaining the same wrapping.  Five copies is five places
// to fix when the driver changes its shape, and — as this project has now
// demonstrated — a standing invitation to write a sixth.  It lives here.

/** The in-memory adapters' emulation of a UNIQUE violation.
 *
 *  Typed, not a message: callers must distinguish "this already exists" from
 *  "the store is broken", and a string match would silently reclassify one as
 *  the other the day a message changes.  The house rule is that in-memory
 *  adapters emulate every DB protection, so they raise this where Postgres
 *  would raise 23505. */
export class UniqueViolationError extends Error {
  constructor(readonly constraintLabel: string) {
    super(`unique constraint violated: ${constraintLabel}`);
    this.name = 'UniqueViolationError';
  }
}

/** How far down a `cause` chain to look.  Drizzle nests one level; the margin
 *  is for a driver that decides to nest more. */
const MAX_CAUSE_DEPTH = 4;

/** Walk `error` and its `cause` chain, yielding each link. */
function* causeChain(error: unknown): Generator<Record<string, unknown>> {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || current === undefined) return;
    yield current as Record<string, unknown>;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * Did this write hit a UNIQUE constraint (Postgres 23505), rather than fail?
 *
 * Recognises both the real driver error — wherever on the cause chain Drizzle
 * has buried it — and the in-memory adapters' `UniqueViolationError`, so a
 * caller reads the same answer from either.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (error instanceof UniqueViolationError) return true;
  for (const link of causeChain(error)) {
    if (link['code'] === '23505') return true;
  }
  return false;
}

/**
 * The violated constraint's name, from anywhere in the cause chain — for the
 * callers that must tell WHICH unique refused them (a row can carry several).
 * Empty string when the driver did not name one.
 */
export function uniqueViolationConstraint(error: unknown): string {
  if (error instanceof UniqueViolationError) return error.constraintLabel;
  for (const link of causeChain(error)) {
    const name = link['constraint_name'];
    if (typeof name === 'string') return name;
  }
  return '';
}

/** The in-memory adapters' emulation of a CHECK / trigger refusal.
 *
 *  Same reasoning as `UniqueViolationError`: the house rule is that in-memory
 *  adapters emulate every database protection, so a suite that never touches
 *  Postgres still exercises the semantics production has.  Without this the
 *  `stories_room_visibility` / `rooms_visibility_no_public_stories` triggers
 *  (migration 0110) would hold in production and be invisible to every test —
 *  the worst arrangement, since the behaviour the tests describe would be the
 *  one production does NOT have. */
export class CheckViolationError extends Error {
  constructor(readonly constraintLabel: string) {
    super(`check constraint violated: ${constraintLabel}`);
    this.name = 'CheckViolationError';
  }
}

/**
 * Did this write hit a CHECK constraint or a trigger's `check_violation`
 * (Postgres 23514), rather than fail?
 *
 * A refusal, not an outage — the caller must answer it with a 409 that tells the
 * client what is in the way, never a 503 that invites a retry which cannot
 * succeed.
 */
export function isCheckViolation(error: unknown): boolean {
  if (error instanceof CheckViolationError) return true;
  for (const link of causeChain(error)) {
    if (link['code'] === '23514') return true;
  }
  return false;
}

/**
 * The two partial uniques that mean "this URL already exists in the target tier".
 *
 * ONE list, because there were three spellings of it — an inline array in
 * `ingestion/visibility.ts`, string literals in the in-memory story adapter, and
 * (until this was shared) nothing at all in the room-visibility cascade, which
 * consequently treated ANY unique violation as a link duplicate.  A
 * `stories_media_upload_ref_uq` refusal was reported to a steward as "1 public story
 * shares a link with an existing in-room story" — a claim the code had not verified
 * and the steward could not act on.
 *
 * Only these two mean duplicate-story.  Any other constraint is a different bug and
 * must keep propagating rather than be relabelled.
 */
export const TIER_UNIQUE_PUBLIC_CONSTRAINT = 'stories_canonical_url_public_uq';
export const TIER_UNIQUE_ROOM_CONSTRAINT = 'stories_canonical_url_room_uq';
export const TIER_UNIQUE_CONSTRAINTS: readonly string[] = [
  TIER_UNIQUE_PUBLIC_CONSTRAINT,
  TIER_UNIQUE_ROOM_CONSTRAINT,
];

/** Was this refusal one of the tier URL uniques (and therefore a duplicate story)? */
export function isTierUniqueViolation(error: unknown): boolean {
  return (
    isUniqueViolation(error) && TIER_UNIQUE_CONSTRAINTS.includes(uniqueViolationConstraint(error))
  );
}

/**
 * Extra attempts when a tier-unique refusal names no readable incumbent.
 *
 * The refusal and the lookup that names the winner are two statements, and between
 * them the incumbent can be hidden, deleted, or moved to another tier — after which
 * the write that was refused would succeed.  Shared so the story path and the room
 * cascade cannot disagree about how patient to be.
 */
export const TIER_COLLISION_RETRIES = 2;
