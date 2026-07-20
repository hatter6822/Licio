// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Centralized DOMPurify configuration (WS-G.4.2a, SPEC §6.12.7/§25.2) — stage
// two of the UGC defense-in-depth pipeline.  ONE dedicated DOMPurify instance
// carries the UGC allow-list; every UGC rendering path uses it through
// {@link renderUGC} (WS-G.4.2b) — there is no per-call configuration anywhere.
//
// Trusted Types: when the platform exposes `trustedTypes`, the instance mints
// its output through the named `licio-ugc` policy (registered here exactly
// once), so the CSP directive `trusted-types default dompurify licio-ugc`
// confines TrustedHTML creation to known policies and
// `require-trusted-types-for 'script'` blocks every unvetted sink assignment.
import createDOMPurify, { type Config, type DOMPurify, type WindowLike } from 'dompurify';

/** The Trusted Types policy type DOMPurify accepts (extracted from its config
 *  so this module never references DOM-lib globals — shared compiles with
 *  `lib: ["ES2022"]`). */
type DompurifyTrustedTypesPolicy = NonNullable<Config['TRUSTED_TYPES_POLICY']>;

/** The Trusted Types policy name minting UGC TrustedHTML (must stay in CSP). */
export const UGC_TRUSTED_TYPES_POLICY_NAME = 'licio-ugc';

/** WS-G.4.2a ALLOWED_TAGS — the complete UGC element vocabulary. */
export const UGC_ALLOWED_TAGS = [
  'p',
  'h1',
  'h2',
  'h3',
  'strong',
  'em',
  'code',
  'pre',
  'a',
  'blockquote',
  'ul',
  'ol',
  'li',
  'br',
] as const;

/** WS-G.4.2a ALLOWED_ATTR — href (anchors) — the single attribute the WS-G serializer emits. */
export const UGC_ALLOWED_ATTR = ['href'] as const;

/** WS-G.4.2a ALLOWED_URI_REGEXP — http, https, mailto only. */
export const UGC_ALLOWED_URI_REGEXP = /^(?:https?:|mailto:)/i;

/** WS-G.4.2a FORBID_TAGS — belt-and-suspenders on top of the allow-list. */
export const UGC_FORBID_TAGS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'textarea',
  'select',
  'button',
  'svg',
  'math',
] as const;

/** WS-G.4.2a FORBID_ATTR — event handlers, style, srcset, formaction. */
export const UGC_FORBID_ATTR = [
  'style',
  'srcset',
  'formaction',
  // DOMPurify drops on* handlers by default (they are never in ALLOWED_ATTR);
  // listing the common ones keeps the ban explicit and grep-able.
  'onerror',
  'onload',
  'onclick',
  'onmouseover',
  'onfocus',
  'onauxclick',
  'onanimationstart',
] as const;

interface TrustedTypePolicyLike {
  createHTML(input: string): unknown;
  createScriptURL(input: string): unknown;
}

interface TrustedTypesFactoryLike {
  createPolicy(
    name: string,
    rules: {
      createHTML: (input: string) => string;
      createScriptURL: (input: string) => string;
    },
  ): TrustedTypePolicyLike;
}

/** Resolve the global window-like host, if one exists (browser or jsdom). */
function resolveWindow(): (WindowLike & { trustedTypes?: TrustedTypesFactoryLike }) | null {
  if (typeof globalThis === 'undefined') return null;
  const candidate = (globalThis as { window?: unknown }).window;
  if (candidate && typeof candidate === 'object' && 'document' in candidate) {
    return candidate as WindowLike & { trustedTypes?: TrustedTypesFactoryLike };
  }
  return null;
}

let cachedSanitizer: DOMPurify | null = null;
let cachedPolicy: TrustedTypePolicyLike | null = null;
let policyCreationAttempted = false;

/**
 * Register (once) the `licio-ugc` Trusted Types policy.  The policy is a pure
 * pass-through used ONLY by the configured DOMPurify instance below — nothing
 * else can reach it because it is module-private.  Returns null where Trusted
 * Types are unsupported (the strict CSP remains the cross-browser backstop).
 */
function ugcTrustedTypesPolicy(
  windowLike: { trustedTypes?: TrustedTypesFactoryLike } | null,
): TrustedTypePolicyLike | null {
  if (policyCreationAttempted) return cachedPolicy;
  policyCreationAttempted = true;
  const factory = windowLike?.trustedTypes;
  if (!factory) return null;
  try {
    cachedPolicy = factory.createPolicy(UGC_TRUSTED_TYPES_POLICY_NAME, {
      createHTML: (input: string) => input,
      // DOMPurify requires the hook's presence; it is only ever CALLED for
      // TrustedScriptURL attributes (script.src), which the UGC allow-list
      // can never produce — so it throws (fail closed) rather than mint.
      createScriptURL: () => {
        throw new Error('licio-ugc never creates script URLs');
      },
    });
  } catch {
    // Policy already exists or the CSP forbids creation — fail closed by
    // leaving the policy null; DOMPurify then returns strings and the CSP
    // sink enforcement (where active) rejects unvetted assignment.
    cachedPolicy = null;
  }
  return cachedPolicy;
}

/**
 * The single shared UGC sanitizer (WS-G.4.2a).  Returns null in environments
 * without a usable DOM (plain Node) — callers MUST fail closed (renderUGC
 * degrades to escaped plain text, never to unsanitized markup).
 */
export function getUgcSanitizer(): DOMPurify | null {
  if (cachedSanitizer?.isSupported) return cachedSanitizer;
  const windowLike = resolveWindow();
  if (!windowLike) return null;
  const instance = createDOMPurify(windowLike);
  if (!instance.isSupported) return null;

  instance.setConfig({
    ALLOWED_TAGS: [...UGC_ALLOWED_TAGS],
    ALLOWED_ATTR: [...UGC_ALLOWED_ATTR],
    ALLOWED_URI_REGEXP: UGC_ALLOWED_URI_REGEXP,
    FORBID_TAGS: [...UGC_FORBID_TAGS],
    FORBID_ATTR: [...UGC_FORBID_ATTR],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_TRUSTED_TYPE: true,
    ...(() => {
      const policy = ugcTrustedTypesPolicy(windowLike);
      return policy !== null
        ? { TRUSTED_TYPES_POLICY: policy as unknown as DompurifyTrustedTypesPolicy }
        : {};
    })(),
  });

  // WS-G.4.2a link handling: every surviving anchor gets
  // rel="noopener noreferrer" and an explicit target so a UGC link can never
  // reach `window.opener` or inherit the app's browsing context silently.
  instance.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A') {
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('target', '_blank');
    }
  });

  cachedSanitizer = instance;
  return instance;
}

/** Test seam: drop the cached instance/policy (jsdom lifecycles in Vitest). */
export function resetUgcSanitizerForTests(): void {
  cachedSanitizer = null;
  cachedPolicy = null;
  policyCreationAttempted = false;
}
