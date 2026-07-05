// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A wallet-drainer-safe external link (WS-G.4.2c, SPEC §18.5).  Anywhere a
// user-supplied URL is rendered as a real anchor OUTSIDE the UGC sink — comment
// source lists, debate-arena citation lists — MUST use this instead of a plain
// `<a target="_blank">`, so the destination passes the SAME drainer blocklist +
// heuristics check and shows the interstitial for a suspicious host.  (Links
// INSIDE Markdown-lite bodies are already intercepted by `UgcBody`.)
//
// The verdict resolves in a MICROTASK (the cached blocklist — never a network
// round-trip), so the transient user activation survives to `window.open` and
// the destination is not popup-blocked on a clean verdict.
import { useState } from 'react';
import { checkLinkSafety } from '../../lib/link-safety.js';
import { openExternal } from '../../lib/open-external.js';
import { LinkInterstitial } from './LinkInterstitial.js';

export interface SafeExternalLinkProps {
  /** The user-supplied destination (already schema-validated as http(s)/doi). */
  href: string;
  className?: string;
  children: React.ReactNode;
}

export function SafeExternalLink({
  href,
  className,
  children,
}: SafeExternalLinkProps): React.ReactElement {
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);

  const activate = (event: { preventDefault: () => void }): void => {
    // doi:/mailto: are not browsing destinations the interstitial covers; let
    // the browser's default handling take them.
    if (!/^https?:\/\//i.test(href)) return;
    event.preventDefault();
    void checkLinkSafety(href).then((verdict) => {
      if (verdict.suspicious) setPendingUrl(href);
      else openExternal(href, () => setPendingUrl(href));
    });
  };

  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noreferrer nofollow"
        className={className}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key === 'Enter') activate(event);
        }}
      >
        {children}
      </a>
      {pendingUrl !== null && (
        <LinkInterstitial
          url={pendingUrl}
          onContinue={() => {
            openExternal(pendingUrl, () => {});
            setPendingUrl(null);
          }}
          onBack={() => setPendingUrl(null)}
        />
      )}
    </>
  );
}
