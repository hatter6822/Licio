// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ops helper: generate a VAPID key pair for Web Push (WS-C.2.4a). Run with:
//   pnpm --filter api exec tsx scripts/generate-vapid-keys.ts
// Add the printed values to the server environment. The PRIVATE key must NEVER be
// committed or shipped to the client bundle (SPEC §6.8/§21.2).
import { generateVapidKeys } from '../src/lib/vapid.js';

const keys = generateVapidKeys();
console.log('VAPID_PUBLIC_KEY=', keys.publicKey);
console.log('VAPID_PRIVATE_KEY=', keys.privateKey);
console.log('VAPID_SUBJECT=mailto:ops@example.com');
