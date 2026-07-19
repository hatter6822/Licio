// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Module-local structural type for the WHATWG `URL` global (available in
// every supported runtime: browsers and Node ≥ 18).  Declared locally — not
// via the DOM lib or @types/node — so @licio/shared stays environment-neutral
// (the same pattern as utils/url.ts).

export interface UgcWhatwgUrl {
  readonly protocol: string;
  readonly hostname: string;
  readonly pathname: string;
  readonly search: string;
  /** The fragment, including the leading `#` (empty when absent).  Hash-routed
   *  dApps carry their action in here, so link-safety must inspect it too. */
  readonly hash: string;
  toString(): string;
}

const runtimeGlobals = globalThis as unknown as {
  URL: new (input: string) => UgcWhatwgUrl;
};

/** Parse with the runtime WHATWG URL; returns null instead of throwing. */
export function tryParseUrl(input: string): UgcWhatwgUrl | null {
  try {
    return new runtimeGlobals.URL(input);
  } catch {
    return null;
  }
}
