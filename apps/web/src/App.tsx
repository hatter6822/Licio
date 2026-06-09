// SPDX-License-Identifier: AGPL-3.0-or-later
import { APP_NAME, APP_VERSION } from '@licio/shared';

export function App() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas text-ink">
      <div className="text-center">
        <h1 className="text-4xl font-bold">{APP_NAME}</h1>
        <p className="mt-2 text-ink-muted">
          v{APP_VERSION} — Social news without popularity voting
        </p>
      </div>
    </main>
  );
}
