// SPDX-License-Identifier: AGPL-3.0-or-later
//
// New-device login detection + multi-channel security alerts (WS-D.1.4d).  Because
// email is optional, alerts are multi-channel: email when one is on file, else Web
// Push, and ALWAYS an in-app security-activity log entry (so a passkey-/wallet-only
// account never silently loses an alert).
//
// PRIVACY AMENDMENT (SPEC §19.1): detection uses ONLY a coarse device descriptor.
// There is NO geolocation, NO country, NO IP, and NO geo-IP lookup of any kind.
import type { AuditEventType, AuthMethod } from '@licio/shared';
import type { AuditStore } from './audit.js';

export interface LoginContext {
  /** Coarse device descriptor (OS/browser family), never the full user agent. */
  deviceProfile: string;
  authMethod: AuthMethod;
}

export type LoginHistoryEntry = Pick<LoginContext, 'deviceProfile'>;

export interface SuspiciousLoginDecision {
  suspicious: boolean;
  reasons: Array<'new_device'>;
}

/**
 * Decide whether a sign-in is from a device descriptor not seen among the user's
 * other active sessions.  The first sign-in (empty history) is never flagged.  A
 * new device raises a NON-blocking alert (the login still succeeds; the user
 * revokes the session if it was not them).  No location/IP is consulted (§19.1).
 */
export function assessLogin(
  current: LoginContext,
  history: readonly LoginHistoryEntry[],
): SuspiciousLoginDecision {
  if (history.length === 0) return { suspicious: false, reasons: [] };
  const knownDevices = new Set(history.map((h) => h.deviceProfile));
  const reasons: Array<'new_device'> = [];
  if (!knownDevices.has(current.deviceProfile)) reasons.push('new_device');
  return { suspicious: reasons.length > 0, reasons };
}

/** Derive a coarse, non-identifying device profile from a user-agent string. */
export function deviceProfile(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  let os = 'Unknown';
  if (/iphone|ipad|ios/.test(ua)) os = 'iOS';
  else if (/android/.test(ua)) os = 'Android';
  else if (/mac os|macintosh/.test(ua)) os = 'macOS';
  else if (/windows/.test(ua)) os = 'Windows';
  else if (/linux/.test(ua)) os = 'Linux';
  let browser = 'Unknown';
  if (/edg\//.test(ua)) browser = 'Edge';
  else if (/chrome|crios/.test(ua)) browser = 'Chrome';
  else if (/firefox|fxios/.test(ua)) browser = 'Firefox';
  else if (/safari/.test(ua)) browser = 'Safari';
  return `${os}/${browser}`;
}

export type AlertChannel = 'email' | 'push' | 'log';

/**
 * Channel selection: email when present, else push, and ALWAYS log.  Returns the
 * ordered channels that {@link sendSecurityAlert} will deliver on.
 */
export function selectAlertChannels(opts: { hasEmail: boolean; hasPush: boolean }): AlertChannel[] {
  const channels: AlertChannel[] = [];
  if (opts.hasEmail) channels.push('email');
  else if (opts.hasPush) channels.push('push');
  channels.push('log');
  return channels;
}

export type SecurityAlertType =
  | 'new_signin'
  | 'cloned_authenticator'
  | 'account_lockout'
  | 'auth_method_added'
  | 'auth_method_removed'
  | 'duplicate_registration_attempt';

const ALERT_AUDIT_EVENT: Record<SecurityAlertType, AuditEventType> = {
  new_signin: 'suspicious_login',
  cloned_authenticator: 'suspicious_login',
  account_lockout: 'account_lockout',
  auth_method_added: 'auth_method_add',
  auth_method_removed: 'auth_method_remove',
  duplicate_registration_attempt: 'suspicious_login',
};

export interface SecurityAlertEvent {
  type: SecurityAlertType;
  /** Minimized context — coarse device descriptor + method only. NO IP, NO location. */
  device?: string | null;
  authMethod?: AuthMethod | null;
}

export interface AlertTransports {
  sendEmail?: (userId: string, event: SecurityAlertEvent) => Promise<void>;
  sendPush?: (userId: string, event: SecurityAlertEvent) => Promise<void>;
}

/**
 * Deliver a security alert across the selected channels and always write the
 * audit-log entry.  The audit redactor strips any IP/secret from the context, so
 * the persisted record (and, by construction here, the email/push payloads) carry
 * a coarse device descriptor + method only — never an IP or location (§19.1).
 */
export async function sendSecurityAlert(opts: {
  userId: string;
  hasEmail: boolean;
  hasPush: boolean;
  audit: AuditStore;
  event: SecurityAlertEvent;
  transports?: AlertTransports;
}): Promise<AlertChannel[]> {
  const channels = selectAlertChannels({ hasEmail: opts.hasEmail, hasPush: opts.hasPush });
  for (const channel of channels) {
    if (channel === 'email') await opts.transports?.sendEmail?.(opts.userId, opts.event);
    else if (channel === 'push') await opts.transports?.sendPush?.(opts.userId, opts.event);
    else {
      await opts.audit.append({
        actorUserId: opts.userId,
        eventType: ALERT_AUDIT_EVENT[opts.event.type],
        context: {
          device: opts.event.device ?? null,
          auth_method: opts.event.authMethod ?? null,
        },
      });
    }
  }
  return channels;
}
