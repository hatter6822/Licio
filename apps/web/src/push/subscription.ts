// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Push subscription lifecycle (WS-C.2.4b, SPEC §6.11 constraint 3). Permission is
// NEVER requested on first load: the UI gates it behind PWA install (required on
// iOS 16.4+) and a contextual moment. On grant we subscribe with the server's
// VAPID public key and register the subscription; we also support renewal
// (pushsubscriptionchange) and unsubscription. A previously denied permission is
// never re-prompted (the browser suppresses it) — the UI points to OS settings.
import type { PushSubscriptionJson } from '@licio/shared';
import {
  fetchVapidPublicKey,
  registerPushSubscription,
  removePushSubscription,
} from '../lib/api.js';
import { track } from '../lib/telemetry.js';

/** Where the reader is in the push-enablement flow (drives the explainer UI). */
export type PushReadiness = 'unsupported' | 'needs-install' | 'denied' | 'ready' | 'subscribed';

/** Convert a base64url VAPID key to the Uint8Array `applicationServerKey` wants. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

export function isPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Running as an installed PWA (display-mode standalone, or iOS `standalone`). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const standaloneDisplay = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standaloneDisplay || iosStandalone;
}

/** iOS/iPadOS detection (push requires home-screen install there, §6.11). */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/iP(hone|ad|od)/.test(navigator.userAgent)) return true;
  // iPadOS reports as Mac; disambiguate via touch points.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/** Resolve the current push readiness without prompting for permission. */
export async function getPushReadiness(): Promise<PushReadiness> {
  if (!isPushSupported()) return 'unsupported';
  if (isIOS() && !isStandalone()) return 'needs-install';
  if (Notification.permission === 'denied') return 'denied';
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  return existing ? 'subscribed' : 'ready';
}

/**
 * Request permission (only call at a contextual moment) and subscribe. Returns
 * the registered subscription, or null when unsupported or not granted. Reuses an
 * existing subscription if present (idempotent).
 */
export async function subscribeToPush(): Promise<PushSubscriptionJson | null> {
  if (!isPushSupported()) return null;
  if (isIOS() && !isStandalone()) return null; // never prompt in iOS Safari
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    track({ name: 'push_lifecycle', metric: 'denied' });
    return null;
  }

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(await fetchVapidPublicKey()),
    }));

  const json = subscription.toJSON() as PushSubscriptionJson;
  await registerPushSubscription(json);
  track({ name: 'push_lifecycle', metric: 'subscribed' });
  return json;
}

/**
 * On app load: if permission is ALREADY granted, ensure the server has the
 * current subscription — re-registering the existing one, or silently
 * re-creating it if the browser dropped it (renew-on-load). Never prompts: a
 * 'default' permission is left untouched so the contextual ask still happens.
 */
export async function ensurePushSubscription(): Promise<void> {
  if (!isPushSupported() || Notification.permission !== 'granted') return;
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(await fetchVapidPublicKey()),
    }));
  await registerPushSubscription(subscription.toJSON() as PushSubscriptionJson);
  if (!existing) track({ name: 'push_lifecycle', metric: 'renewed' });
}

/** Unsubscribe locally and on the server. */
export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await removePushSubscription(subscription.endpoint);
  await subscription.unsubscribe();
  track({ name: 'push_lifecycle', metric: 'unsubscribed' });
}
