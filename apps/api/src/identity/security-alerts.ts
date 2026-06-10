// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Suspicious-login detection + multi-channel security alerts (WS-D.1.4d).  Because
// email is optional, alerts are multi-channel: email when one is on file, else Web
// Push, and ALWAYS an in-app security-activity log entry (so a passkey-/wallet-only
// account never silently loses an alert).  Detection is country- and device-coarse
// only (a local geo DB; never the raw IP, §19.1).
import type { AuditEventType, AuthMethod } from '@licio/shared';
import type { AuditStore } from './audit.js';

export interface LoginContext {
  /** ISO country code from a LOCAL geo lookup (no external API), or null. */
  country: string | null;
  /** Coarse device profile (OS/browser family), never the full user agent. */
  deviceProfile: string;
  authMethod: AuthMethod;
}

export type LoginHistoryEntry = Pick<LoginContext, 'country' | 'deviceProfile'>;

export interface SuspiciousLoginDecision {
  suspicious: boolean;
  reasons: Array<'new_country' | 'new_device'>;
}

/**
 * Decide whether a sign-in is suspicious vs. the user's recent history.  The first
 * sign-in (empty history) is never suspicious.  A new country or a materially
 * different device profile raises a NON-blocking alert (the login still succeeds;
 * the user revokes the session if it was not them).
 */
export function assessLogin(
  current: LoginContext,
  history: readonly LoginHistoryEntry[],
): SuspiciousLoginDecision {
  if (history.length === 0) return { suspicious: false, reasons: [] };
  const knownCountries = new Set(history.map((h) => h.country));
  const knownDevices = new Set(history.map((h) => h.deviceProfile));
  const reasons: Array<'new_country' | 'new_device'> = [];
  if (current.country !== null && !knownCountries.has(current.country)) reasons.push('new_country');
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
  /** Minimized context — country/device/method only, never a raw IP. */
  country?: string | null;
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
 * country/device/method only.
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
          country: opts.event.country ?? null,
          device: opts.event.device ?? null,
          auth_method: opts.event.authMethod ?? null,
        },
      });
    }
  }
  return channels;
}
