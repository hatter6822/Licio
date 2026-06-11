// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Append-only security/privacy audit log (WS-D.1.6c).  The store exposes only
// append + read; there is no update/delete path.  Every entry passes through a
// redactor that enforces the minimized context allowlist and masks any IP- or
// token-like value that slips in (defense in depth — the log must never become a
// secondary surveillance store; §19.3/§25.4).  No IP and no location of any
// granularity is ever recorded (§19.1) — a coarse device descriptor is the most
// location-like value an entry may carry.
import { randomUUID } from 'node:crypto';
import {
  type AuditContext,
  type AuditEntry,
  type AuditEventType,
  auditEntrySchema,
  type SecurityActivityEntry,
} from '@licio/shared';

/** The closed allowlist of context keys that may be persisted. */
// Privacy amendment (SPEC §19.1): NO `country`/location key. The most
// location-like value ever recorded is a coarse `device` descriptor.
const ALLOWED_CONTEXT_KEYS: ReadonlyArray<keyof AuditContext> = [
  'device',
  'auth_method',
  'setting',
  'previous_value',
  'new_value',
  'reason',
];

const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
// Two or more colon groups ⇒ IPv6 (incl. `::` compression).  A single-colon value
// like a "22:00" quiet-hours time has only one group and is NOT masked.
const IPV6 = /(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}/i;
const AUTH_METHODS = new Set(['webauthn', 'email_otp', 'wallet']);

function maskIfSensitive(value: string | null): string | null {
  if (value === null) return null;
  if (IPV4.test(value) || IPV6.test(value)) return null; // never persist an IP
  return value;
}

/**
 * Build a minimized {@link AuditContext} from an arbitrary input object.  Unknown
 * keys are dropped (allowlist), strings are length-bounded and IP-masked, and
 * `auth_method` is validated against the closed enum.
 */
export function redactContext(raw: Record<string, unknown> | undefined): AuditContext {
  const base: AuditContext = {
    device: null,
    auth_method: null,
    setting: null,
    previous_value: null,
    new_value: null,
    reason: null,
  };
  if (!raw) return base;
  for (const key of ALLOWED_CONTEXT_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (key === 'auth_method') {
      base.auth_method =
        typeof value === 'string' && AUTH_METHODS.has(value)
          ? (value as AuditContext['auth_method'])
          : null;
    } else if (typeof value === 'string') {
      base[key] = maskIfSensitive(value.slice(0, 256));
    }
  }
  return base;
}

export interface AuditEntryInput {
  actorUserId: string | null;
  eventType: AuditEventType;
  targetRef?: string | null;
  context?: Record<string, unknown>;
}

/** Assemble a fully-validated, redacted audit entry (no secrets reach storage). */
export function buildAuditEntry(input: AuditEntryInput, createdAt: Date = new Date()): AuditEntry {
  return auditEntrySchema.parse({
    event_id: randomUUID(),
    actor_user_id: input.actorUserId,
    event_type: input.eventType,
    target_ref: input.targetRef ?? null,
    context: redactContext(input.context),
    created_at: createdAt.toISOString(),
  });
}

/** Project a full entry to the owner-visible "recent security activity" subset. */
export function toSecurityActivity(entry: AuditEntry): SecurityActivityEntry {
  return {
    event_id: entry.event_id,
    event_type: entry.event_type,
    context: entry.context,
    created_at: entry.created_at,
  };
}

export interface AuditStore {
  append(input: AuditEntryInput, createdAt?: Date): Promise<AuditEntry>;
  /** Owner-scoped security activity, newest first, capped at `limit`. */
  securityActivityForUser(userId: string, limit?: number): Promise<SecurityActivityEntry[]>;
  clear(): Promise<void>;
}

/**
 * In-memory, append-only audit store.  The backing array is private and exposed
 * only through append + read — there is no mutation/removal method, mirroring the
 * write-once semantics enforced at the DB level (no UPDATE/DELETE code path).
 */
export class InMemoryAuditStore implements AuditStore {
  readonly #entries: AuditEntry[] = [];

  async append(input: AuditEntryInput, createdAt: Date = new Date()): Promise<AuditEntry> {
    const entry = buildAuditEntry(input, createdAt);
    this.#entries.push(entry);
    return entry;
  }

  async securityActivityForUser(userId: string, limit = 50): Promise<SecurityActivityEntry[]> {
    return this.#entries
      .filter((e) => e.actor_user_id === userId)
      .slice(-limit)
      .reverse()
      .map(toSecurityActivity);
  }

  async clear(): Promise<void> {
    this.#entries.length = 0;
  }
}
