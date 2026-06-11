// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Markdown-lite parser + serializer tests (WS-G.4.1).  Pure-node: no DOM —
// the pipeline's first two stages must already be safe on their own.
import { describe, expect, it } from 'vitest';
import { escapeHtml, serializeUgcDocument } from '../ugc/html.js';
import {
  MAX_UGC_INPUT_LENGTH,
  normalizeUgcLink,
  parseUgcMarkdown,
  type UgcBlockNode,
} from '../ugc/markdown.js';

/** Parse + serialize in one step (the constrained-HTML intermediate). */
function toHtml(markdown: string): string {
  return serializeUgcDocument(parseUgcMarkdown(markdown));
}

describe('WS-G.4.1 Markdown-lite parser — allowed elements', () => {
  it('parses paragraphs with soft line breaks', () => {
    expect(toHtml('first line\nsecond line')).toBe('<p>first line<br>second line</p>');
  });

  it('separates paragraphs on blank lines', () => {
    expect(toHtml('one\n\ntwo')).toBe('<p>one</p><p>two</p>');
  });

  it('parses headings h1–h3', () => {
    expect(toHtml('# Title')).toBe('<h1>Title</h1>');
    expect(toHtml('## Section')).toBe('<h2>Section</h2>');
    expect(toHtml('### Sub')).toBe('<h3>Sub</h3>');
  });

  it('treats h4+ as literal paragraph text (not an allowed node)', () => {
    expect(toHtml('#### deep heading')).toBe('<p>#### deep heading</p>');
  });

  it('parses bold, italic, and nested emphasis', () => {
    expect(toHtml('**bold**')).toBe('<p><strong>bold</strong></p>');
    expect(toHtml('*italic*')).toBe('<p><em>italic</em></p>');
    expect(toHtml('_italic_')).toBe('<p><em>italic</em></p>');
    expect(toHtml('**bold *and italic***')).toBe(
      '<p><strong>bold <em>and italic</em></strong></p>',
    );
  });

  it('parses inline code and fenced code blocks verbatim', () => {
    expect(toHtml('`x < y`')).toBe('<p><code>x &lt; y</code></p>');
    expect(toHtml('```\nconst a = "<b>";\n```')).toBe(
      '<pre><code>const a = &quot;&lt;b&gt;&quot;;</code></pre>',
    );
  });

  it('keeps an unterminated fence safe (consumes to EOF)', () => {
    expect(toHtml('```\n<script>alert(1)</script>')).toBe(
      '<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>',
    );
  });

  it('parses links with http/https/mailto and protocol-relative normalization', () => {
    expect(toHtml('[docs](https://example.org/a)')).toBe(
      '<p><a href="https://example.org/a">docs</a></p>',
    );
    expect(toHtml('[mail](mailto:a@example.org)')).toBe(
      '<p><a href="mailto:a@example.org">mail</a></p>',
    );
    expect(toHtml('[cdn](//example.org/lib.js)')).toBe(
      '<p><a href="https://example.org/lib.js">cdn</a></p>',
    );
  });

  it('autolinks bare and angle-bracket URLs', () => {
    expect(toHtml('see https://example.org/x.')).toBe(
      '<p>see <a href="https://example.org/x">https://example.org/x</a>.</p>',
    );
    expect(toHtml('<https://example.org/y>')).toBe(
      '<p><a href="https://example.org/y">https://example.org/y</a></p>',
    );
  });

  it('parses blockquotes (nested, depth-capped)', () => {
    expect(toHtml('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>');
    expect(toHtml('> > inner')).toBe(
      '<blockquote><blockquote><p>inner</p></blockquote></blockquote>',
    );
  });

  it('parses ordered and unordered lists', () => {
    expect(toHtml('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(toHtml('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
    expect(toHtml('* star item')).toBe('<ul><li>star item</li></ul>');
  });
});

describe('WS-G.4.1 Markdown-lite parser — stripping and normalization', () => {
  it('never passes raw HTML through (script, img onerror, iframe)', () => {
    expect(toHtml('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(toHtml('<img src=x onerror=alert(1)>')).toBe(
      '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
    );
    expect(toHtml('<iframe srcdoc=evil></iframe>')).toBe(
      '<p>&lt;iframe srcdoc=evil&gt;&lt;/iframe&gt;</p>',
    );
    // A URL inside pasted markup autolinks (harmless), but the tag itself
    // stays escaped text — no element node is ever produced from raw HTML.
    expect(toHtml('<iframe src="https://evil.example"></iframe>')).toBe(
      '<p>&lt;iframe src=&quot;<a href="https://evil.example/">https://evil.example</a>&quot;&gt;&lt;/iframe&gt;</p>',
    );
  });

  it('drops javascript:/data:/vbscript:/file: link destinations, keeping the label', () => {
    expect(toHtml('[click](javascript:alert(1))')).toBe('<p>click</p>');
    expect(toHtml('[click](data:text/html;base64,PHNjcmlwdD4=)')).toBe('<p>click</p>');
    expect(toHtml('[click](vbscript:msgbox(1))')).toBe('<p>click</p>');
    expect(toHtml('[click](file:///etc/passwd)')).toBe('<p>click</p>');
  });

  it('rejects scheme obfuscation with embedded whitespace/control characters', () => {
    expect(normalizeUgcLink('java\tscript:alert(1)')).toBeNull();
    expect(normalizeUgcLink('java\nscript:alert(1)')).toBeNull();
    expect(normalizeUgcLink('javascript:alert(1)')).toBeNull();
    expect(normalizeUgcLink('JaVaScRiPt:alert(1)')).toBeNull();
  });

  it('rejects relative and schemeless destinations', () => {
    expect(normalizeUgcLink('/relative/path')).toBeNull();
    expect(normalizeUgcLink('relative.html')).toBeNull();
    expect(normalizeUgcLink('')).toBeNull();
  });

  it('rejects mailto with header injection and malformed addresses', () => {
    expect(normalizeUgcLink('mailto:a@example.org?cc=b@example.org')).toBeNull();
    expect(normalizeUgcLink('mailto:not-an-address')).toBeNull();
    expect(normalizeUgcLink('mailto:a@example.org')).toBe('mailto:a@example.org');
  });

  it('drops oversized destinations', () => {
    expect(normalizeUgcLink(`https://example.org/${'a'.repeat(3000)}`)).toBeNull();
  });
});

describe('WS-G.4.1 edge cases', () => {
  it('handles empty and whitespace-only input', () => {
    expect(parseUgcMarkdown('').blocks).toEqual([]);
    expect(parseUgcMarkdown('   \n\n  ').blocks).toEqual([]);
  });

  it('truncates input beyond the 50KB bound and marks it', () => {
    const long = 'a'.repeat(MAX_UGC_INPUT_LENGTH + 1000);
    const document = parseUgcMarkdown(long);
    expect(document.truncated).toBe(true);
    const paragraph = document.blocks[0] as Extract<UgcBlockNode, { kind: 'paragraph' }>;
    const text = paragraph.children[0];
    expect(text?.kind === 'text' && text.value.length === MAX_UGC_INPUT_LENGTH).toBe(true);
  });

  it('strips parser-differential control bytes but keeps newlines/tabs', () => {
    expect(toHtml('a\u0007b\u0000c')).toBe('<p>abc</p>');
  });

  it('survives unicode (emoji, RTL, combining marks) untouched', () => {
    expect(toHtml('🎉 שלום café')).toBe('<p>🎉 שלום café</p>');
  });

  it('degrades malformed emphasis to literal text', () => {
    expect(toHtml('**unclosed bold')).toBe('<p>**unclosed bold</p>');
    expect(toHtml('*')).toBe('<p>*</p>');
  });

  it('caps blockquote nesting (no recursion blow-up)', () => {
    const deep = `${'> '.repeat(64)}x`;
    expect(() => parseUgcMarkdown(deep)).not.toThrow();
  });

  it('escapeHtml escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
