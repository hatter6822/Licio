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
import { jsdomDocument, jsdomWindow, type TestElement } from './jsdom-globals.js';

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

describe('WS-G.4.2a sanitizer is an INDEPENDENT second layer', () => {
  // Every OTHER UGC test routes through `renderUGC`, whose stage-1 Markdown-lite
  // parser already drops event handlers and non-http/mailto schemes — so those
  // tests pass unchanged with the whole attribute half of `setConfig` deleted.
  // These hand the sanitizer raw, parser-bypassing HTML (what a server-rendered
  // summary, an imported LCAP body, or a migrated legacy post would look like)
  // and pin the CONFIG VALUES, not merely the presence of the keys: deletion is
  // already caught by `check:dead-exports` (the constants go unreferenced), so
  // the regression left uncaught is WIDENING them back toward DOMPurify's
  // permissive defaults.
  function sanitizeToElement(html: string, selector: string): TestElement {
    const template = jsdomDocument().createElement('template');
    template.innerHTML = String(getUgcSanitizer()?.sanitize(html));
    const element = template.content.querySelector(selector);
    if (element === null) throw new Error(`sanitizer dropped the ${selector} element entirely`);
    return element;
  }

  it('strips `style` from a surviving element (FORBID_ATTR + ALLOWED_ATTR)', () => {
    // A full-viewport transparent overlay is a clickjacking primitive, and
    // DOMPurify's DEFAULT ALLOWED_ATTR includes `style` — only this config's
    // `href`-only allow-list plus FORBID_ATTR keeps it out.
    const p = sanitizeToElement('<p style="position:fixed;inset:0;opacity:0">x</p>', 'p');
    expect(p.getAttribute('style')).toBeNull();
    expect(p.getAttributeNames()).toEqual([]);
  });

  it('drops an href whose scheme is outside http/https/mailto (ALLOWED_URI_REGEXP)', () => {
    // DOMPurify's built-in default URI regexp PERMITS tel:/sms:/cid:/xmpp:; only
    // `UGC_ALLOWED_URI_REGEXP` narrows the anchor target space to the web.  (A
    // `javascript:` href is deliberately NOT asserted here — the library default
    // already rejects it, so it cannot distinguish the configured layer.)
    for (const href of ['tel:+15551234', 'sms:+15551234', 'cid:evil', 'xmpp:a@b']) {
      const anchor = sanitizeToElement(`<a href="${href}">x</a>`, 'a');
      expect(anchor.getAttribute('href')).toBeNull();
    }
    // …and the two non-http schemes the regexp DOES admit survive.
    expect(sanitizeToElement('<a href="mailto:a@b.example">x</a>', 'a').getAttribute('href')).toBe(
      'mailto:a@b.example',
    );
    expect(sanitizeToElement('<a href="http://a.example/p">x</a>', 'a').getAttribute('href')).toBe(
      'http://a.example/p',
    );
  });

  it('drops data-* and aria-* attributes (ALLOW_DATA_ATTR / ALLOW_ARIA_ATTR false)', () => {
    // The two keys no static gate covers at all: DOMPurify defaults BOTH to
    // true, so a widened config would let UGC inject `aria-label` (a screen-reader
    // spoofing surface) and arbitrary `data-*` hooks into the app's own DOM.
    const p = sanitizeToElement('<p data-x="1" aria-label="y">z</p>', 'p');
    expect(p.getAttribute('data-x')).toBeNull();
    expect(p.getAttribute('aria-label')).toBeNull();
    expect(p.getAttributeNames()).toEqual([]);
  });

  it('keeps ONLY href plus the hook-added rel/target on an anchor (ALLOWED_ATTR)', () => {
    // `id`/`title`/`class` are all in DOMPurify's default allow-list; the exact
    // attribute set is the assertion, so a widened ALLOWED_ATTR fails here even
    // when nothing dangerous is present in the sample.
    const anchor = sanitizeToElement(
      '<a href="https://ok.example" id="x" title="y" class="z">q</a>',
      'a',
    );
    expect(anchor.getAttributeNames().sort()).toEqual(['href', 'rel', 'target']);
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
