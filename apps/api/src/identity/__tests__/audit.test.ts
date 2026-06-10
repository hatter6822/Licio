// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  buildAuditEntry,
  InMemoryAuditStore,
  redactContext,
  toSecurityActivity,
} from '../audit.js';

describe('redactContext', () => {
  it('keeps only allowlisted keys and drops the rest (incl. any country/location)', () => {
    const ctx = redactContext({
      country: 'us', // location is NOT an allowed key (§19.1) — dropped
      device: 'iPhone',
      auth_method: 'webauthn',
      injected: 'evil',
      session_token: 'super-secret',
    } as Record<string, unknown>);
    expect('country' in ctx).toBe(false);
    expect(ctx.device).toBe('iPhone');
    expect(ctx.auth_method).toBe('webauthn');
    expect('injected' in ctx).toBe(false);
    expect('session_token' in ctx).toBe(false);
  });

  it('masks an IP that slips into a string field', () => {
    expect(redactContext({ device: 'box at 203.0.113.7' }).device).toBeNull();
    expect(redactContext({ new_value: '2001:db8::1' }).new_value).toBeNull();
  });

  it('rejects an invalid auth_method', () => {
    expect(redactContext({ auth_method: 'password' }).auth_method).toBeNull();
  });

  it('records a privacy-setting diff (previous → new)', () => {
    const ctx = redactContext({
      setting: 'personalization_enabled',
      previous_value: 'true',
      new_value: 'false',
    });
    expect(ctx.setting).toBe('personalization_enabled');
    expect(ctx.previous_value).toBe('true');
    expect(ctx.new_value).toBe('false');
  });

  it('returns an all-null context for no input', () => {
    expect(redactContext(undefined)).toEqual({
      device: null,
      auth_method: null,
      setting: null,
      previous_value: null,
      new_value: null,
    });
  });
});

describe('buildAuditEntry', () => {
  it('produces a valid, fully-populated entry with a fresh id', () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const entry = buildAuditEntry(
      {
        actorUserId: '11111111-1111-4111-8111-111111111111',
        eventType: 'login_success',
        context: { device: 'iOS/Safari' },
      },
      at,
    );
    expect(entry.event_type).toBe('login_success');
    expect(entry.context.device).toBe('iOS/Safari');
    expect(entry.created_at).toBe(at.toISOString());
    expect(entry.event_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('accepts a system event (null actor) and a hashed target ref', () => {
    const entry = buildAuditEntry({
      actorUserId: null,
      eventType: 'deletion_complete',
      targetRef: 'abc123hash',
    });
    expect(entry.actor_user_id).toBeNull();
    expect(entry.target_ref).toBe('abc123hash');
  });
});

describe('InMemoryAuditStore', () => {
  it('is append-only (no update/delete method) and owner-scoped on read', async () => {
    const store = new InMemoryAuditStore();
    const u1 = '11111111-1111-4111-8111-111111111111';
    const u2 = '22222222-2222-4222-8222-222222222222';
    await store.append({ actorUserId: u1, eventType: 'login_success' });
    await store.append({ actorUserId: u1, eventType: 'session_create' });
    await store.append({ actorUserId: u2, eventType: 'login_success' });

    const activity = await store.securityActivityForUser(u1);
    expect(activity).toHaveLength(2);
    // Newest first.
    expect(activity[0]?.event_type).toBe('session_create');
    // Cross-user entries are not visible.
    expect(
      (await store.securityActivityForUser(u2)).every((e) => e.event_type === 'login_success'),
    ).toBe(true);

    // Structural: the store exposes no mutation/removal beyond append + clear.
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
    expect(methods).not.toContain('update');
    expect(methods).not.toContain('remove');
  });

  it('caps the returned activity to the limit', async () => {
    const store = new InMemoryAuditStore();
    const u = '11111111-1111-4111-8111-111111111111';
    for (let i = 0; i < 60; i += 1)
      await store.append({ actorUserId: u, eventType: 'login_success' });
    expect(await store.securityActivityForUser(u, 10)).toHaveLength(10);
  });
});

describe('toSecurityActivity', () => {
  it('drops actor and target_ref from the owner-facing view', () => {
    const entry = buildAuditEntry({
      actorUserId: '11111111-1111-4111-8111-111111111111',
      eventType: 'mfa_enroll',
      targetRef: 'secret-ref',
    });
    const view = toSecurityActivity(entry) as Record<string, unknown>;
    expect('actor_user_id' in view).toBe(false);
    expect('target_ref' in view).toBe(false);
    expect(view['event_type']).toBe('mfa_enroll');
  });
});
