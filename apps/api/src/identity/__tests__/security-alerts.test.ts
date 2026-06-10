// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuditStore } from '../audit.js';
import {
  assessLogin,
  deviceProfile,
  selectAlertChannels,
  sendSecurityAlert,
} from '../security-alerts.js';

describe('assessLogin', () => {
  const history = [
    { country: 'US', deviceProfile: 'macOS/Chrome' },
    { country: 'US', deviceProfile: 'iOS/Safari' },
  ];

  it('never flags the first sign-in (empty history)', () => {
    expect(
      assessLogin({ country: 'GB', deviceProfile: 'X/Y', authMethod: 'webauthn' }, []),
    ).toEqual({
      suspicious: false,
      reasons: [],
    });
  });

  it('flags a new country', () => {
    const d = assessLogin(
      { country: 'FR', deviceProfile: 'macOS/Chrome', authMethod: 'webauthn' },
      history,
    );
    expect(d.suspicious).toBe(true);
    expect(d.reasons).toContain('new_country');
  });

  it('flags a new device', () => {
    const d = assessLogin(
      { country: 'US', deviceProfile: 'Windows/Edge', authMethod: 'email_otp' },
      history,
    );
    expect(d.suspicious).toBe(true);
    expect(d.reasons).toContain('new_device');
  });

  it('does not flag a familiar country+device', () => {
    expect(
      assessLogin({ country: 'US', deviceProfile: 'macOS/Chrome', authMethod: 'webauthn' }, history)
        .suspicious,
    ).toBe(false);
  });
});

describe('deviceProfile', () => {
  it('coarsely classifies common user agents', () => {
    expect(deviceProfile('Mozilla/5.0 (iPhone; CPU iPhone OS 17) Safari')).toBe('iOS/Safari');
    expect(deviceProfile('Mozilla/5.0 (Windows NT 10.0) Chrome/120')).toBe('Windows/Chrome');
    expect(deviceProfile('Mozilla/5.0 (Macintosh) Firefox/120')).toBe('macOS/Firefox');
    expect(deviceProfile('weird-bot')).toBe('Unknown/Unknown');
  });
});

describe('selectAlertChannels', () => {
  it('prefers email, falls back to push, and ALWAYS logs', () => {
    expect(selectAlertChannels({ hasEmail: true, hasPush: true })).toEqual(['email', 'log']);
    expect(selectAlertChannels({ hasEmail: false, hasPush: true })).toEqual(['push', 'log']);
    expect(selectAlertChannels({ hasEmail: false, hasPush: false })).toEqual(['log']);
  });
});

describe('sendSecurityAlert', () => {
  it('emails when present and always writes the audit log (no raw IP in payload)', async () => {
    const audit = new InMemoryAuditStore();
    const sendEmail = vi.fn(async () => {});
    const sendPush = vi.fn(async () => {});
    const userId = '11111111-1111-4111-8111-111111111111';

    const channels = await sendSecurityAlert({
      userId,
      hasEmail: true,
      hasPush: true,
      audit,
      transports: { sendEmail, sendPush },
      event: { type: 'new_signin', country: 'FR', device: 'macOS/Chrome', authMethod: 'webauthn' },
    });

    expect(channels).toEqual(['email', 'log']);
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendPush).not.toHaveBeenCalled();
    const activity = await audit.securityActivityForUser(userId);
    expect(activity[0]?.event_type).toBe('suspicious_login');
    expect(activity[0]?.context.country).toBe('FR');
    expect(JSON.stringify(activity[0])).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });

  it('falls back to push when there is no email, still logging', async () => {
    const audit = new InMemoryAuditStore();
    const sendPush = vi.fn(async () => {});
    const userId = '22222222-2222-4222-8222-222222222222';
    const channels = await sendSecurityAlert({
      userId,
      hasEmail: false,
      hasPush: true,
      audit,
      transports: { sendPush },
      event: { type: 'cloned_authenticator' },
    });
    expect(channels).toEqual(['push', 'log']);
    expect(sendPush).toHaveBeenCalledOnce();
    expect(await audit.securityActivityForUser(userId)).toHaveLength(1);
  });

  it('logs even with no transports at all (passkey-only, no email, no push subscription)', async () => {
    const audit = new InMemoryAuditStore();
    const userId = '33333333-3333-4333-8333-333333333333';
    const channels = await sendSecurityAlert({
      userId,
      hasEmail: false,
      hasPush: false,
      audit,
      event: { type: 'account_lockout' },
    });
    expect(channels).toEqual(['log']);
    expect((await audit.securityActivityForUser(userId))[0]?.event_type).toBe('account_lockout');
  });
});
