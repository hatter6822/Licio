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
  event.waitUntil(self.registration.showNotification(title, options));
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
