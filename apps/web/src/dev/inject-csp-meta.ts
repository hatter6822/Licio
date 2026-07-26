// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Build helper (NOT app runtime code — imported only by `vite.config.ts`, so it
// never enters the client bundle).
//
// `index.html` carries NO Content-Security-Policy of its own.  It used to, and
// that copy was one of three hand-maintained spellings of the same policy: a
// header tightened in `apps/api` without a matching edit here left the WS-R.15.4a
// native courier WebView — which serves the built assets from `https://localhost`
// with no server headers, so the `<meta>` is its ONLY policy — running the older,
// weaker rules, with nothing to catch it.
//
// So the tag is INJECTED at build time from the single source in
// `@licio/shared` (`security/csp.ts`) instead.  Injection also removes the need
// to strip the tag in dev: the Vite DEV server never gets one, and it could not
// tolerate one anyway (HMR uses inline `<style>`, inline/eval script and a dev
// WebSocket, all of which `style-src 'self'` / `require-trusted-types-for
// 'script'` / `connect-src 'self'` block).
//
// Pure and DOM-free so it is directly unit-testable.

/** Where the tag goes: immediately after `<head>` (before any other metadata,
 *  matching how a server header applies to the whole document). */
const HEAD_OPEN = /<head(\s[^>]*)?>/i;

/**
 * Elements whose CONTENT a parser never treats as live markup.
 *
 * `script`/`style`/`textarea`/`title` hold raw or escapable-raw text — a
 * `<meta>` written there is characters, not a tag.  `template` content IS
 * parsed, but into an INERT fragment: a CSP `<meta>` inside one has no effect
 * whatsoever, which makes it the most dangerous of the set, because it looks
 * exactly like a delivered policy to anything matching on text.
 */
const INERT_CONTENT_ELEMENTS = ['script', 'style', 'textarea', 'title', 'template'] as const;

/** Opens one of the above.  Sticky, so the scan stays linear over the document. */
const INERT_OPEN = new RegExp(`<(${INERT_CONTENT_ELEMENTS.join('|')})\\b[^>]*>`, 'iy');

/**
 * Blank everything a parser would NOT read as live markup, preserving length
 * and newlines: comment bodies, and the CONTENT of the inert elements above.
 *
 * `<head>` inside a comment is not the head, and a CSP `<meta>` inside a
 * `<template>` is not a policy — but a pattern scanning raw text cannot tell.
 * Injecting into either produces a document whose only CSP is inert: no policy
 * at all, and in the courier WebView no response header to fall back on, while
 * every string comparison downstream still matches.
 *
 * The element TAGS stay visible — only their content is blanked — so a
 * `<script src>` still counts as content the policy must precede.
 *
 * Masking rather than deleting keeps every offset valid, so a caller can scan
 * the masked copy and splice into (or report against) the ORIGINAL.  Shared
 * with `check:csp-parity` so the injector and the gate that verifies it agree
 * on what counts as markup — two spellings of that rule is how a green gate
 * ends up describing a document nobody delivers.
 */
export function maskInertMarkup(html: string): string {
  // UTF-16 units, matching `indexOf`/`slice`, so offsets stay comparable.
  const chars = html.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < chars.length; k += 1) if (chars[k] !== '\n') chars[k] = ' ';
  };
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== '<') {
      i += 1;
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const close = html.indexOf('-->', i + 4);
      // An unterminated comment runs to the end of the document, as in a parser.
      const end = close === -1 ? chars.length : close + 3;
      blank(i, end);
      i = end;
      continue;
    }
    INERT_OPEN.lastIndex = i;
    const open = INERT_OPEN.exec(html);
    if (open === null) {
      i += 1;
      continue;
    }
    const name = (open[1] ?? '').toLowerCase();
    const contentFrom = i + open[0].length;
    // `<template>` NESTS; the raw-text elements cannot, so their first close tag
    // ends them.  Depth-counting only the nesting case keeps this exact.
    const end =
      name === 'template'
        ? endOfTemplate(html, contentFrom)
        : indexOfClose(html, name, contentFrom);
    blank(contentFrom, end);
    i = Math.max(end, contentFrom);
  }
  return chars.join('');
}

/** Offset of `</name>` at or after `from`, or the end of the document. */
function indexOfClose(html: string, name: string, from: number): number {
  const close = new RegExp(`</${name}\\s*>`, 'i');
  const rest = html.slice(from);
  const found = close.exec(rest);
  return found === null ? html.length : from + found.index;
}

/** Offset of the `</template>` that closes the one opened before `from`. */
function endOfTemplate(html: string, from: number): number {
  const scan = /<(\/?)template\b[^>]*>/gi;
  scan.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null = scan.exec(html);
  while (match !== null) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) return match.index;
    match = scan.exec(html);
  }
  return html.length;
}

/** Escape a policy for a double-quoted HTML attribute.  The directive set is
 *  first-party and quote-free, but building markup by concatenation without
 *  escaping is the habit that eventually produces an injection. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Insert the CSP `<meta http-equiv>` into `html`.
 *
 * Returns the document UNCHANGED when it has no `<head>` — there is nowhere
 * valid to put it, and a tag spliced elsewhere would be ignored by the parser
 * while looking, to a reader, like the policy was applied.  Callers that need
 * the guarantee assert on the OUTPUT (`check:csp-parity` reads the built file).
 */
export function injectCspMeta(html: string, policy: string): string {
  // Located in the MASKED copy so a `<head>` written inside a comment cannot
  // capture the injection; spliced into the original, whose offsets it shares.
  const match = HEAD_OPEN.exec(maskInertMarkup(html));
  if (!match) return html;
  const tag = `\n    <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}" />`;
  return (
    html.slice(0, match.index + match[0].length) + tag + html.slice(match.index + match[0].length)
  );
}
