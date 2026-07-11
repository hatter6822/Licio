// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuditStore } from '../audit.js';
import {
  assessLogin,
  createAlertTransports,
  deviceProfile,
  selectAlertChannels,
  sendSecurityAlert,
} from '../security-alerts.js';

describe('assessLogin (device-only; no location/IP per §19.1)', () => {
  const history = [{ deviceProfile: 'macOS/Chrome' }, { deviceProfile: 'iOS/Safari' }];

  it('never flags the first sign-in (empty history)', () => {
    expect(assessLogin({ deviceProfile: 'X/Y', authMethod: 'webauthn' }, [])).toEqual({
      suspicious: false,
      reasons: [],
    });
  });

  it('flags a new device descriptor', () => {
    const d = assessLogin({ deviceProfile: 'Windows/Edge', authMethod: 'email_otp' }, history);
    expect(d.suspicious).toBe(true);
    expect(d.reasons).toContain('new_device');
  });

  it('does not flag a familiar device', () => {
    expect(
      assessLogin({ deviceProfile: 'macOS/Chrome', authMethod: 'webauthn' }, history).suspicious,
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
      event: { type: 'new_signin', device: 'macOS/Chrome', authMethod: 'webauthn' },
    });

    expect(channels).toEqual(['email', 'log']);
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendPush).not.toHaveBeenCalled();
    const activity = await audit.securityActivityForUser(userId);
    expect(activity[0]?.event_type).toBe('suspicious_login');
    expect(activity[0]?.context.device).toBe('macOS/Chrome');
    // No location/IP is ever recorded (§19.1): no country key, no IPv4.
    expect('country' in (activity[0]?.context ?? {})).toBe(false);
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

describe('createAlertTransports (the boot-wired real channels, WS-D.1.4d)', () => {
  const userId = '44444444-4444-4444-8444-444444444444';

  it('emails the minimized §19.1 payload through the mailer notice channel', async () => {
    const sendNotice = vi.fn(async () => {});
    const transports = createAlertTransports({
      getUserEmail: async () => 'owner@example.com',
      sendNotice,
      onError: () => {},
    });
    await transports.sendEmail?.(userId, {
      type: 'new_signin',
      device: 'macOS/Chrome',
      authMethod: 'webauthn',
    });
    expect(sendNotice).toHaveBeenCalledWith('owner@example.com', 'security_alert', {
      alert: 'new_signin',
      device: 'macOS/Chrome',
      auth_method: 'webauthn',
    });
  });

  it('re-checks the email at DELIVERY time — a just-removed address is never mailed', async () => {
    const sendNotice = vi.fn(async () => {});
    const transports = createAlertTransports({
      getUserEmail: async () => null,
      sendNotice,
      onError: () => {},
    });
    await transports.sendEmail?.(userId, { type: 'account_lockout' });
    expect(sendNotice).not.toHaveBeenCalled();
  });

  it('is best-effort: a mailer failure reports through onError and never throws', async () => {
    const onError = vi.fn();
    const transports = createAlertTransports({
      getUserEmail: async () => 'owner@example.com',
      sendNotice: async () => {
        throw new Error('ses outage');
      },
      onError,
    });
    await expect(
      transports.sendEmail?.(userId, { type: 'cloned_authenticator' }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('email', expect.any(Error));
  });

  it('wires the push wake only when provided, and swallows its failures too', async () => {
    const withoutPush = createAlertTransports({
      getUserEmail: async () => null,
      sendNotice: async () => {},
      onError: () => {},
    });
    expect(withoutPush.sendPush).toBeUndefined();

    const onError = vi.fn();
    const withPush = createAlertTransports({
      getUserEmail: async () => null,
      sendNotice: async () => {},
      sendPushWake: async () => {
        throw new Error('push endpoint gone');
      },
      onError,
    });
    await expect(withPush.sendPush?.(userId, { type: 'new_signin' })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('push', expect.any(Error));
  });
});
