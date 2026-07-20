// SPDX-License-Identifier: AGPL-3.0-or-later
import DOMPurify from 'dompurify';

interface TrustedTypePolicyFactory {
  createPolicy(
    name: string,
    policy: {
      createHTML?: (input: string) => string;
      createScript?: (input: string) => string;
      createScriptURL?: (input: string) => string;
    },
  ): unknown;
}

export function initTrustedTypes(): void {
  if (typeof window === 'undefined') {
    return;
  }

  const tt = (window as { trustedTypes?: TrustedTypePolicyFactory }).trustedTypes;
  if (!tt) {
    return;
  }

  tt.createPolicy('default', {
    createHTML: () => {
      throw new Error('Direct HTML assignment is blocked by Trusted Types policy. Use DOMPurify.');
    },
    createScript: () => {
      throw new Error('Direct script creation is blocked by Trusted Types policy.');
    },
    createScriptURL: (url: string) => {
      // Resolve against this origin and compare ORIGINS — a prefix/startsWith check
      // is bypassable (`https://app.example.evil.com`, `https://app.example@evil`,
      // protocol-relative `//evil`). Same-origin only; everything else throws.
      let resolved: URL;
      try {
        resolved = new URL(url, window.location.origin);
      } catch {
        throw new Error(`Blocked invalid script URL: ${url}`);
      }
      if (resolved.origin === window.location.origin) {
        return url;
      }
      throw new Error(`Blocked script URL from external origin: ${url}`);
    },
  });

  const dompurifyPolicy = tt.createPolicy('dompurify', {
    createHTML: (input: string) => input,
    // DOMPurify's config validation requires createScriptURL to exist; UGC/sanitized
    // HTML can never legitimately mint a script URL, so fail closed.
    createScriptURL: () => {
      throw new Error('dompurify policy never creates script URLs');
    },
  });

  DOMPurify.setConfig({
    RETURN_TRUSTED_TYPE: true,
    TRUSTED_TYPES_POLICY: dompurifyPolicy as NonNullable<
      Parameters<typeof DOMPurify.setConfig>[0]
    >['TRUSTED_TYPES_POLICY'],
  });
}
