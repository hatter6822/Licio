// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE single sanctioned UGC rendering surface (WS-G.4.2b, SPEC §25.2).
// Every piece of user-authored Markdown-lite reaches the DOM through exactly
// this component: raw markdown → renderUGC (AST → constrained HTML →
// DOMPurify `licio-ugc` → TrustedHTML) → React.  The Biome
// `noDangerouslySetInnerHtml` rule is suppressed HERE AND ONLY HERE — any
// other suppression in the codebase is a review-blocking violation; the rule
// is exactly the WS-G.4.2b "no bypass paths" gate.
//
// External-link safety (WS-G.4.2c): clicks on rendered anchors are
// intercepted via React event delegation (the sanitized HTML carries no JS,
// so delegation is the only hook), checked against the drainer blocklist +
// heuristics, and suspicious destinations get the interstitial.  The
// continue/back choice is never tied to the user's identity.
import { renderUGC } from '@licio/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { checkLinkSafety } from '../../lib/link-safety.js';
import { LinkInterstitial } from './LinkInterstitial.js';

export interface UgcBodyProps {
  /** Raw Markdown-lite as stored (never pre-rendered HTML). */
  markdown: string;
  /** Compact typography for nested/inline contexts. */
  compact?: boolean;
}

/**
 * Open an external destination in a new tab with the opener severed.  The
 * `noopener` FEATURE STRING is deliberately not used: per spec it makes
 * `window.open` return null even on success, which would make popup
 * blocking undetectable — instead the opener is nulled on the returned
 * proxy (the same security property), and an actual block (null return)
 * falls back to the caller (the interstitial offers a fresh user gesture
 * instead of failing silently).
 */
function openExternal(href: string, onBlocked: () => void): void {
  const opened = window.open(href, '_blank');
  // Falsy (not just null) covers environments whose open() returns
  // undefined — jsdom, some embedders — as well as spec-compliant blocking.
  if (!opened) {
    onBlocked();
    return;
  }
  opened.opener = null;
}

export function UgcBody({ markdown, compact = false }: UgcBodyProps): React.ReactElement {
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const html = useMemo(() => renderUGC(markdown), [markdown]);

  // DOM-level event delegation (a NATIVE listener, deliberately not a JSX
  // handler): the sanitized HTML cannot carry handlers, so intercepting the
  // rendered anchors' activation here is the only hook for the WS-G.4.2c
  // interstitial.  Keyboard users are covered twice over — anchors are
  // natively keyboard-operable (Enter fires click), and the keydown listener
  // mirrors it for environments that do not synthesize that click.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const intercept = (event: Event): void => {
      const anchor = (event.target as HTMLElement).closest('a');
      if (!anchor) return;
      if (event instanceof KeyboardEvent && event.key !== 'Enter') return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('mailto:')) return;
      // Hold navigation until the safety verdict; mailto passes through.
      // The verdict resolves in a MICROTASK (cached blocklist — never the
      // network), so transient user activation survives to window.open.
      event.preventDefault();
      void checkLinkSafety(href).then((verdict) => {
        if (verdict.suspicious) {
          setPendingUrl(href);
        } else {
          openExternal(href, () => setPendingUrl(href));
        }
      });
    };
    container.addEventListener('click', intercept);
    container.addEventListener('keydown', intercept);
    return () => {
      container.removeEventListener('click', intercept);
      container.removeEventListener('keydown', intercept);
    };
  }, []);

  return (
    <>
      <div
        ref={containerRef}
        className={compact ? 'ugc-body ugc-body-compact' : 'ugc-body'}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: THE WS-G.4.2b sanctioned sink — the value is renderUGC output (Markdown-lite AST → DOMPurify licio-ugc → TrustedHTML); no other dangerouslySetInnerHTML exists in the codebase.
        dangerouslySetInnerHTML={{ __html: html as string }}
      />
      {pendingUrl !== null && (
        <LinkInterstitial
          url={pendingUrl}
          onContinue={() => {
            // A direct user gesture: if even this is blocked there is no
            // further fallback — the dialog simply stays for another try.
            openExternal(pendingUrl, () => {});
            setPendingUrl(null);
          }}
          onBack={() => setPendingUrl(null)}
        />
      )}
    </>
  );
}
