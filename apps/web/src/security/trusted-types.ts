// SPDX-License-Identifier: AGPL-3.0-or-later

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
      if (url.startsWith(window.location.origin) || url.startsWith('/')) {
        return url;
      }
      throw new Error(`Blocked script URL from external origin: ${url}`);
    },
  });
}

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
