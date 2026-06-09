// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from 'react';
import { cn } from '../../../lib/cn.js';
import { SkipToContent } from '../../a11y/index.js';

export interface AppShellProps {
  /** Primary navigation (the BottomNav) — the page's single <nav>. */
  nav: ReactNode;
  /** Optional top-level banner chrome (logo / global actions). */
  banner?: ReactNode;
  /** Optional desktop footer (contentinfo landmark). */
  footer?: ReactNode;
  /** Main content. Pages render their own PageHeader (with the <h1>) here. */
  children: ReactNode;
  className?: string;
}

/**
 * Root layout (WS-B.1.5). Semantic landmarks (header/main/nav/footer), a
 * skip-to-content link as the first focusable element, and a thumb-zone bottom
 * nav on mobile that becomes a side rail at lg+. The `<main>` carries
 * `tabindex=-1` so the SPA focus manager (WS-B.1.6) can land focus on it.
 */
export function AppShell({
  nav,
  banner,
  footer,
  children,
  className,
}: AppShellProps): React.ReactElement {
  return (
    <div className={cn('flex min-h-dvh flex-col lg:flex-row', className)}>
      <SkipToContent />
      {/* Side rail first on desktop; the nav positions itself fixed-bottom on mobile. */}
      <div className="contents lg:order-first">{nav}</div>

      <div className="flex min-h-dvh flex-1 flex-col">
        {banner ? <header className="border-b border-line bg-canvas">{banner}</header> : null}
        <main
          id="main"
          tabIndex={-1}
          className="flex-1 pb-[calc(env(safe-area-inset-bottom)+4.5rem)] focus-visible:outline-none lg:pb-0"
        >
          {children}
        </main>
        {footer ? (
          <footer className="hidden border-t border-line bg-canvas lg:block">{footer}</footer>
        ) : null}
      </div>
    </div>
  );
}
