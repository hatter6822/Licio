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
