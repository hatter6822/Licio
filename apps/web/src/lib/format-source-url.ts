// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Present a source URL "efficiently expanded" for the WS-T Sources footnote
// list: the registrable host (without a leading `www.`) emphasised, plus a
// trimmed path/query so a long link stays readable on one or two lines.  Pure +
// total: an unparseable string returns as-is with an empty tail.
export interface FormattedSourceUrl {
  /** The host, `www.` stripped (e.g. `example.org`). */
  readonly host: string;
  /** The path + query, trimmed; empty for a bare-host URL. */
  readonly rest: string;
}

const MAX_REST = 64;

export function formatSourceUrl(url: string): FormattedSourceUrl {
  try {
    const parsed = new URL(url);
    const host = parsed.host.replace(/^www\./i, '');
    let rest = `${parsed.pathname}${parsed.search}`;
    if (rest === '/') rest = '';
    if (rest.length > MAX_REST) rest = `${rest.slice(0, MAX_REST - 1)}…`;
    return { host, rest };
  } catch {
    return { host: url, rest: '' };
  }
}
