// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
//
// OWASP XSS vector suite (WS-G.4.2d, SPEC §25.2/§18.4) — a CI gate.  Every
// vector runs through the FULL renderUGC pipeline (Markdown-lite AST →
// constrained HTML → DOMPurify `licio-ugc`) and the output is structurally
// audited in a real (jsdom) DOM: no element outside the WS-G.4.2a allow-list,
// no event-handler or style/srcset/formaction attribute, no non-http(s)/
// mailto URL — therefore no vector can yield executable JavaScript.
//
// Fixture sources: OWASP XSS Filter Evasion Cheat Sheet (XFECS), OWASP XSS
// Prevention Cheat Sheet (XPCS), PortSwigger XSS cheat sheet (PSXSS), and
// published mXSS research (mXSS).  Extend this file when new vector families
// are published; each fixture documents its source.
import { afterEach, describe, expect, it } from 'vitest';
import { resetUgcSanitizerForTests, UGC_ALLOWED_TAGS } from '../ugc/dompurify.js';
import { renderUGC, renderUGCDetailed } from '../ugc/render.js';
import { jsdomDocument, SHOW_ELEMENT } from './jsdom-globals.js';

afterEach(() => resetUgcSanitizerForTests());

const ALLOWED_ELEMENTS = new Set<string>(UGC_ALLOWED_TAGS.map((t) => t.toUpperCase()));
const ALLOWED_ATTRIBUTES = new Set(['href', 'class', 'rel', 'target']);

/**
 * Structural safety audit: parse the pipeline output in an inert template
 * and verify the allow-list invariants hold for EVERY node and attribute.
 */
function auditSafety(vector: string): void {
  const html = String(renderUGC(vector));

  // String-level fast check: a literal `<script` can never appear (the `<`
  // of escaped text is always `&lt;`).  Dangerous SCHEMES may appear as
  // inert escaped TEXT (someone may quote them); the DOM walk below is the
  // gate that proves they never reach an attribute position.
  expect(html.toLowerCase()).not.toContain('<script');

  const template = jsdomDocument().createElement('template');
  template.innerHTML = html;
  const walker = jsdomDocument().createTreeWalker(template.content, SHOW_ELEMENT);
  let element = walker.nextNode();
  while (element !== null) {
    expect(ALLOWED_ELEMENTS.has(element.nodeName)).toBe(true);
    for (const attribute of element.getAttributeNames()) {
      expect(attribute.startsWith('on')).toBe(false);
      expect(ALLOWED_ATTRIBUTES.has(attribute)).toBe(true);
      if (attribute === 'href') {
        const value = element.getAttribute('href') ?? '';
        expect(/^(?:https?:|mailto:)/i.test(value)).toBe(true);
      }
    }
    element = walker.nextNode();
  }
}

interface Vector {
  /** Source: XFECS | XPCS | PSXSS | mXSS (+ short note). */
  readonly source: string;
  readonly payload: string;
}

const VECTORS: Record<string, readonly Vector[]> = {
  'script injection': [
    { source: 'XFECS basic', payload: '<script>alert(1)</script>' },
    { source: 'XFECS no quotes/semicolons', payload: '<script>alert(1)</script>' },
    { source: 'XFECS breakout', payload: '</p><script>alert(1)</script><p>' },
    { source: 'XFECS src-based', payload: '<script src="https://evil.example/x.js"></script>' },
    { source: 'PSXSS uppercase', payload: '<SCRIPT>alert(1)</SCRIPT>' },
    { source: 'XFECS nested tag', payload: '<scr<script>ipt>alert(1)</scr</script>ipt>' },
    { source: 'PSXSS newline split', payload: '<scri\npt>alert(1)</scri\npt>' },
  ],
  'event-handler injection': [
    { source: 'XFECS img onerror', payload: '<img src=x onerror=alert(1)>' },
    { source: 'XFECS body onload', payload: '<body onload=alert(1)>' },
    { source: 'XFECS onmouseover', payload: '<div onmouseover="alert(1)">hover</div>' },
    { source: 'PSXSS onfocus autofocus', payload: '<input onfocus=alert(1) autofocus>' },
    { source: 'PSXSS details ontoggle', payload: '<details open ontoggle=alert(1)>' },
    {
      source: 'PSXSS onanimationstart',
      payload: '<p style="animation:x" onanimationstart=alert(1)>',
    },
    {
      source: 'XFECS onauxclick',
      payload: '<a href="https://e.example" onauxclick=alert(1)>x</a>',
    },
    { source: 'XFECS marquee onstart', payload: '<marquee onstart=alert(1)>x</marquee>' },
  ],
  'URL-scheme injection': [
    { source: 'XFECS javascript href (markdown)', payload: '[x](javascript:alert(1))' },
    { source: 'XFECS javascript href (html)', payload: '<a href="javascript:alert(1)">x</a>' },
    {
      source: 'XFECS data html',
      payload: '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    },
    { source: 'XFECS vbscript', payload: '[x](vbscript:msgbox(1))' },
    { source: 'XFECS tab obfuscation', payload: '[x](jav\tascript:alert(1))' },
    { source: 'XFECS newline obfuscation', payload: '[x](jav\nascript:alert(1))' },
    { source: 'XFECS embedded NUL', payload: '[x](java\x00script:alert(1))' },
    { source: 'PSXSS mixed case', payload: '[x](JaVaScRiPt:alert(1))' },
    { source: 'PSXSS colon entity', payload: '<a href="javascript&colon;alert(1)">x</a>' },
    { source: 'XFECS protocol-relative js', payload: '[x](//evil.example/x.js)' },
  ],
  'CSS injection': [
    {
      source: 'XFECS style expression',
      payload: '<div style="width:expression(alert(1))">x</div>',
    },
    {
      source: 'XFECS style url-js',
      payload: '<div style="background:url(javascript:alert(1))">x</div>',
    },
    { source: 'XFECS style tag', payload: '<style>@import "https://evil.example/x.css";</style>' },
    {
      source: 'PSXSS style attribute on allowed tag',
      payload: '<p style="position:fixed;top:0">x</p>',
    },
  ],
  'SVG injection': [
    { source: 'XFECS svg onload', payload: '<svg/onload=alert(1)>' },
    { source: 'PSXSS svg script', payload: '<svg><script>alert(1)</script></svg>' },
    {
      source: 'PSXSS svg animate',
      payload: '<svg><animate onbegin=alert(1) attributeName=x dur=1s>',
    },
    {
      source: 'PSXSS svg use href',
      payload: '<svg><use href="data:image/svg+xml;base64,PHN2Zy8+#x"/></svg>',
    },
    {
      source: 'PSXSS svg foreignObject',
      payload:
        '<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>',
    },
  ],
  'MathML injection': [
    {
      source: 'PSXSS math href',
      payload:
        '<math><maction actiontype="statusline#https://evil.example" xlink:href="javascript:alert(1)">x</maction></math>',
    },
    {
      source: 'mXSS math mglyph',
      payload:
        '<math><mtext><mglyph><style><img src=x onerror=alert(1)></style></mglyph></mtext></math>',
    },
  ],
  'encoding tricks': [
    { source: 'XPCS named entities', payload: '&lt;script&gt;alert(1)&lt;/script&gt;' },
    { source: 'XPCS decimal entities', payload: '&#60;script&#62;alert(1)&#60;/script&#62;' },
    { source: 'XPCS hex entities', payload: '&#x3C;script&#x3E;alert(1)&#x3C;/script&#x3E;' },
    {
      source: 'XFECS entity-encoded js href',
      payload:
        '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>',
    },
    { source: 'XFECS percent encoding', payload: '[x](%6A%61%76%61%73%63%72%69%70%74:alert(1))' },
    { source: 'PSXSS unicode escapes', payload: '<script>\\u0061lert(1)</script>' },
    { source: 'XFECS null byte in tag', payload: '<scr\x00ipt>alert(1)</scr\x00ipt>' },
    { source: 'PSXSS overlong-UTF8 surrogate text', payload: 'a�<script>alert(1)</script>�' },
    { source: 'PSXSS double encoding', payload: '%253Cscript%253Ealert(1)%253C/script%253E' },
    { source: 'XFECS mixed-case tag', payload: '<ScRiPt>alert(1)</ScRiPt>' },
    { source: 'XFECS fullwidth brackets', payload: '＜script＞alert(1)＜/script＞' },
  ],
  'mutation XSS': [
    {
      source: 'mXSS noscript',
      payload: '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    },
    { source: 'mXSS template', payload: '<template><script>alert(1)</script></template>' },
    { source: 'mXSS form-in-form', payload: '<form><form><input name=parentNode></form></form>' },
    {
      source: 'mXSS namespace confusion',
      payload: '<svg></p><style><a id="</style><img src=x onerror=alert(1)>">',
    },
    {
      source: 'mXSS comment breakout',
      payload: '<!--<img src="--><img src=x onerror=alert(1)//">',
    },
    {
      source: 'mXSS p-in-table hoist',
      payload: '<table><p title="</table><img src=x onerror=alert(1)>">',
    },
  ],
  'DOM clobbering': [
    { source: 'PSXSS name=body', payload: '<img name=body><img src=x onerror=alert(1)>' },
    {
      source: 'PSXSS id=location anchor',
      payload: '<a id=location href="https://evil.example">x</a>',
    },
    {
      source: 'PSXSS form attributes clobber',
      payload: '<form id=test onforminput=alert(1)><input></form>',
    },
  ],
  'frame/object/embed/meta': [
    { source: 'XFECS iframe', payload: '<iframe src="javascript:alert(1)"></iframe>' },
    {
      source: 'XFECS iframe srcdoc',
      payload: '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    },
    {
      source: 'XFECS object',
      payload: '<object data="data:text/html;base64,PHNjcmlwdD4="></object>',
    },
    { source: 'XFECS embed', payload: '<embed src="https://evil.example/x.swf">' },
    { source: 'XFECS base hijack', payload: '<base href="https://evil.example/">' },
    {
      source: 'XFECS meta refresh',
      payload: '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    },
    {
      source: 'XFECS form action',
      payload: '<form action="javascript:alert(1)"><button>x</button></form>',
    },
    { source: 'PSXSS formaction', payload: '<button formaction="javascript:alert(1)">x</button>' },
    { source: 'PSXSS srcset', payload: '<img srcset="x 1x" src=x onerror=alert(1)>' },
  ],
};

describe('WS-G.4.2d OWASP XSS vector suite (CI gate)', () => {
  const allVectors = Object.entries(VECTORS).flatMap(([family, vectors]) =>
    vectors.map((vector) => ({ family, ...vector })),
  );

  it('covers at least 50 vectors across all required families', () => {
    expect(allVectors.length).toBeGreaterThanOrEqual(50);
    expect(Object.keys(VECTORS).length).toBeGreaterThanOrEqual(9);
  });

  it.each(allVectors.map((v) => [`${v.family}: ${v.source}`, v.payload] as const))(
    'renders safely — %s',
    (_name, payload) => {
      auditSafety(payload);
    },
  );

  it('is idempotent under re-rendering (mutation stability)', () => {
    for (const { payload } of allVectors) {
      const once = String(renderUGC(payload));
      // Rendering the OUTPUT again may escape markup further but must never
      // introduce new elements/attributes — re-audit the re-render.
      auditSafety(once);
    }
  });

  it('safely renders each vector when embedded in surrounding markdown (stored-XSS shape)', () => {
    for (const { payload } of allVectors) {
      auditSafety(`# Heading\n\nbenign **intro** text\n\n${payload}\n\n> quoted tail`);
    }
  });

  it('handles oversized hostile input without throwing', () => {
    const giant = `${'<img src=x onerror=alert(1)>'.repeat(4000)}`;
    const detail = renderUGCDetailed(giant);
    expect(detail.truncated).toBe(true);
    auditSafety(giant);
  });
});
