// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Service-worker push + activation handlers (WS-C.2.4b / WS-C.2.1c). Plain SW
// code imported by the Workbox-generated service worker via importScripts —
// SAME-ORIGIN ONLY, no remote code, no eval (WS-C.2.1d). The push payload carries
// no sensitive content; the worker shows a minimal, explainable notification
// (SPEC §6.7) and groups same-thread notifications by tag (WS-C.2.4c).

/* global self, clients */

// Update lifecycle: activate the waiting worker when the client confirms.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Notification budget meter (WS-C.2.4c): a per-UTC-day count of notifications
// shown, kept in a tiny dedicated IndexedDB the settings UI reads. Counts only —
// never contents. Mirrors offline/notification-meter.ts.
function openMeterDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('licio-meter', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('counts', { keyPath: 'day' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function meterRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function recordNotificationShown() {
  try {
    const db = await openMeterDb();
    const day = new Date().toISOString().slice(0, 10);
    const existing = await meterRequest(db.transaction('counts').objectStore('counts').get(day));
    const count = (existing && typeof existing.count === 'number' ? existing.count : 0) + 1;
    await meterRequest(
      db.transaction('counts', 'readwrite').objectStore('counts').put({ day, count }),
    );
    db.close();
  } catch {
    // Non-fatal: the budget indicator is best-effort.
  }
}

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = {};
    }
  }
  const title = typeof payload.title === 'string' ? payload.title : 'Licio';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : 'You have a new update.',
    // Same tag collapses repeated same-thread notifications (grouping default).
    tag: typeof payload.tag === 'string' ? payload.tag : 'licio-notification',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: typeof payload.url === 'string' ? payload.url : '/' },
  };
  event.waitUntil(
    Promise.all([self.registration.showNotification(title, options), recordNotificationShown()]),
  );
});

// Convert a base64url VAPID key to the Uint8Array `applicationServerKey` wants.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

// Silent re-subscription when the browser rotates/expires the subscription
// (WS-C.2.4b edge case). Same-origin only; mirrors the client's single-use CSRF
// flow. Best-effort: the client renew-on-load is the fallback if this fails.
async function resubscribeAndRegister() {
  try {
    const keyRes = await fetch('/v1/push/vapid-public-key', { credentials: 'include' });
    if (!keyRes.ok) return;
    const { publicKey } = await keyRes.json();
    const subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const csrfRes = await fetch('/api/csrf-token', { credentials: 'include' });
    if (!csrfRes.ok) return;
    const { token } = await csrfRes.json();
    await fetch('/v1/push/subscriptions', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
  } catch {
    // Network failure or unsupported — the foreground renew-on-load recovers.
  }
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(resubscribeAndRegister());
});

// Background Sync (WS-C.2.3): when the browser fires a sync for the pending
// queue, wake any open client to run the VALIDATED replay (the queue's zod
// trust-boundary logic lives in the client, not duplicated in the worker).
async function notifyClientsToFlush() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) {
    client.postMessage({ type: 'licio-sync-flush' });
  }
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'licio-pending-queue') {
    event.waitUntil(notifyClientsToFlush());
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          if ('navigate' in client) {
            client.navigate(target);
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
