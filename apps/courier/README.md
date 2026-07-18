# Licio native Android courier (WS-R.15.4a)

The courier is the **same PWA in a native shell**: a Capacitor 8 Android
project that loads the unchanged web build inside the system WebView and
carries the same LCAP packs over native radio links.  No courier-only web
fork, no parallel data model.

## `capacitor.config.json`

The configuration is deliberately a **static JSON file** (not
`capacitor.config.ts`): the Capacitor CLI parses a TS config by transpiling
it through the legacy `typescript` JS API (`ts.transpileModule` /
`ts.ModuleKind`), which the TypeScript 7 native compiler no longer exposes —
JSON is read directly and keeps the courier build decoupled from the
compiler's API surface.  The values encode the WS-R.15.4a security posture:

- `webDir: ../web/dist` — the courier serves the **canonical web build**
  directly; there is structurally no courier-only web fork (the
  `check-no-fork` byte-identity gate proves it).
- `server.androidScheme: https` — bundled assets are served from
  `https://localhost`, so the WebView is a **secure context**: the PWA's
  service worker, WebCrypto, IndexedDB (`lcap_v2`), Trusted Types, and the
  meta-tag CSP all behave exactly as on the web (the §22.5 "no parallel
  trust path" requirement).  No cleartext.
- `android.allowMixedContent: false`, `captureInput: false`,
  `webContentsDebuggingEnabled: false` — the web security posture is
  preserved inside the system WebView with no relaxation.

## Building

```bash
pnpm --filter web build       # the web build must precede (webDir)
pnpm --filter courier build   # no-fork gate + cap sync + debug APK
pnpm --filter courier test:unit  # Layer-1+2 JVM unit tests (no emulator)
```

Requires the Android SDK and JDK 21 for the Gradle steps; `cap sync` alone
needs neither.
