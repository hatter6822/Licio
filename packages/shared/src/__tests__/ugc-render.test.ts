// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
//
// renderUGC pipeline tests (WS-G.4.2a/b): centralized DOMPurify config,
// `licio-ugc` Trusted Types policy registration, link rel/target hook, and
// graceful behavior on empty/oversized input.
import { afterEach, describe, expect, it } from 'vitest';
import {
  getUgcSanitizer,
  resetUgcSanitizerForTests,
  UGC_ALLOWED_TAGS,
  UGC_TRUSTED_TYPES_POLICY_NAME,
} from '../ugc/dompurify.js';
import { renderUGC, renderUGCDetailed, type UgcSafeHtml } from '../ugc/render.js';
import { jsdomDocument, jsdomWindow } from './jsdom-globals.js';

afterEach(() => {
  resetUgcSanitizerForTests();
  delete jsdomWindow().trustedTypes;
});

describe('WS-G.4.2b UgcSafeHtml nominal brand', () => {
  it('rejects a raw, unbranded string at the type level', () => {
    // @ts-expect-error — a plain string cannot satisfy the branded UgcSafeHtml;
    // only `renderUGC`/`renderUGCDetailed` output (which carries the unique-symbol
    // brand) may be assigned here. If this stops erroring, the brand went no-op.
    const x: UgcSafeHtml = 'raw';
    // The runtime value is irrelevant; the guarantee is the compile-time rejection.
    expect(String(x)).toBe('raw');
  });

  it('accepts genuine pipeline output', () => {
    const html: UgcSafeHtml = renderUGC('hello');
    expect(String(html)).toContain('hello');
  });
});

describe('WS-G.4.2a centralized DOMPurify configuration', () => {
  it('provides one shared, supported sanitizer in a DOM environment', () => {
    const sanitizer = getUgcSanitizer();
    expect(sanitizer).not.toBeNull();
    expect(sanitizer?.isSupported).toBe(true);
    // Centralized: repeated calls return the same configured instance.
    expect(getUgcSanitizer()).toBe(sanitizer);
  });

  it('preserves every allowed tag and strips every forbidden tag', () => {
    for (const tag of UGC_ALLOWED_TAGS) {
      if (tag === 'br') continue; // void element renders without content
      const out = String(getUgcSanitizer()?.sanitize(`<${tag}>x</${tag}>`));
      // Closing tag proves the element survived (anchors gain hook attrs).
      expect(out).toContain(`</${tag}>`);
    }
    for (const forbidden of ['script', 'style', 'iframe', 'object', 'embed', 'form', 'svg']) {
      const out = String(getUgcSanitizer()?.sanitize(`<${forbidden}>x</${forbidden}>`));
      expect(out.toLowerCase()).not.toContain(`<${forbidden}`);
    }
  });

  it('adds rel="noopener noreferrer" and target="_blank" to anchors via the hook', () => {
    const html = String(renderUGC('[docs](https://example.org/a)'));
    const template = jsdomDocument().createElement('template');
    template.innerHTML = html;
    const anchor = template.content.querySelector('a');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('href')).toBe('https://example.org/a');
  });

  it('registers and uses the licio-ugc Trusted Types policy when available', () => {
    const created: string[] = [];
    jsdomWindow().trustedTypes = {
      createPolicy: (name: string, rules: { createHTML: (input: string) => string }) => {
        created.push(name);
        return {
          createHTML: (input: string) => ({
            __ttBrand: name,
            toString: () => rules.createHTML(input),
          }),
          createScriptURL: () => {
            throw new Error('never');
          },
        };
      },
    };
    const out = renderUGC('**hello**');
    expect(created).toEqual([UGC_TRUSTED_TYPES_POLICY_NAME]);
    expect((out as { __ttBrand?: string }).__ttBrand).toBe('licio-ugc');
    expect(String(out)).toBe('<p><strong>hello</strong></p>');
  });

  it('fails closed when policy creation is refused (CSP denies the name)', () => {
    jsdomWindow().trustedTypes = {
      createPolicy: () => {
        throw new Error('policy denied by CSP');
      },
    };
    // No throw, and output is still sanitized (string form; the CSP sink
    // enforcement is the runtime backstop in real browsers).
    expect(String(renderUGC('**x**'))).toBe('<p><strong>x</strong></p>');
  });
});

describe('WS-G.4.2b renderUGC composition', () => {
  it('renders markdown through the full pipeline', () => {
    expect(String(renderUGC('# Title\n\n**bold** and [link](https://example.org)'))).toBe(
      '<h1>Title</h1><p><strong>bold</strong> and <a href="https://example.org/" rel="noopener noreferrer" target="_blank">link</a></p>',
    );
  });

  it('handles empty, null, and undefined input', () => {
    expect(String(renderUGC(''))).toBe('');
    expect(String(renderUGC(null))).toBe('');
    expect(String(renderUGC(undefined))).toBe('');
  });

  it('flags truncation on oversized input and still renders safely', () => {
    const result = renderUGCDetailed('x'.repeat(60_000));
    expect(result.truncated).toBe(true);
    expect(result.degraded).toBe(false);
    expect(String(result.html).startsWith('<p>x')).toBe(true);
  });

  it('never throws on pathological input', () => {
    const inputs = ['\x00', '['.repeat(10_000), '*'.repeat(10_000), '\\', '<<<<>>>>'];
    for (const input of inputs) {
      expect(() => renderUGC(input)).not.toThrow();
    }
  });
});
