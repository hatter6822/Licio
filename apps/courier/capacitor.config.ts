// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4a — the Capacitor configuration for the Licio native Android courier.
// The courier is the SAME PWA in a native shell: `webDir` points DIRECTLY at the
// canonical web build (`apps/web/dist`), so there is structurally no courier-only
// web fork (the `check-no-fork` gate proves it).  `androidScheme: 'https'` serves
// the bundled assets from `https://localhost` so the WebView is a SECURE CONTEXT —
// the PWA's service worker, WebCrypto, IndexedDB (`lcap_v2`), Trusted Types, and
// the meta-tag CSP all behave exactly as on the web (the §22.5 "no parallel
// trust path" requirement).  No cleartext, no `script-src`/TT relaxation.

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.licio.courier',
  appName: 'Licio Courier',
  // The UNCHANGED web build — never a courier-local copy of the app source.
  webDir: '../web/dist',
  server: {
    // Serve bundled assets over https://localhost (a secure context); no cleartext.
    androidScheme: 'https',
  },
  android: {
    // Preserve the web security posture inside the system WebView.
    allowMixedContent: false,
    captureInput: false,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
