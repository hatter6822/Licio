// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Web Push subscription lifecycle (WS-C.2.4b). Permission is requested only at a
// contextual moment, gated behind PWA install on iOS; subscriptions are created
// with the server VAPID key and registered/renewed/removed via the BFF.
export {
  getPushReadiness,
  isIOS,
  isPushSupported,
  isStandalone,
  type PushReadiness,
  renewSubscription,
  subscribeToPush,
  unsubscribeFromPush,
  urlBase64ToUint8Array,
} from './subscription.js';
