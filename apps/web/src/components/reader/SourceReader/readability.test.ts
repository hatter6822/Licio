// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { extractReadable } from './readability.js';

describe('extractReadable (WS-B.2.7)', () => {
  it('extracts the title, headings, paragraphs and list items in order', () => {
    const html = `
      <html><head><title>River report</title></head><body>
        <article>
          <h2>What happened</h2>
          <p>The river crested overnight.</p>
          <h3>Evidence</h3>
          <ul><li>Gauge A</li><li>Gauge B</li></ul>
          <p>Levels are now falling.</p>
        </article>
      </body></html>`;
    const result = extractReadable(html);
    expect(result.title).toBe('River report');
    expect(result.blocks).toEqual([
      { type: 'heading', level: 2, text: 'What happened' },
      { type: 'paragraph', level: 2, text: 'The river crested overnight.' },
      { type: 'heading', level: 3, text: 'Evidence' },
      { type: 'listitem', level: 3, text: 'Gauge A' },
      { type: 'listitem', level: 3, text: 'Gauge B' },
      { type: 'paragraph', level: 2, text: 'Levels are now falling.' },
    ]);
  });

  it('strips boilerplate regions (nav, script, style, footer)', () => {
    const html = `
      <nav><p>Home</p></nav>
      <script>alert('x')</script>
      <style>p{color:red}</style>
      <main><p>Real content.</p></main>
      <footer><p>Copyright</p></footer>`;
    const result = extractReadable(html);
    expect(result.blocks).toEqual([{ type: 'paragraph', level: 2, text: 'Real content.' }]);
  });

  it('decodes HTML entities and collapses whitespace', () => {
    const html = '<article><p>Tom &amp; Jerry &mdash;   spaced &#39;quote&#39;</p></article>';
    expect(extractReadable(html).blocks[0]?.text).toBe("Tom & Jerry — spaced 'quote'");
  });

  it('strips inline markup, keeping only text', () => {
    const html = '<article><p>See <a href="/x"><strong>this</strong></a> source.</p></article>';
    expect(extractReadable(html).blocks[0]?.text).toBe('See this source.');
  });

  it('returns an empty block list for content-free input', () => {
    expect(extractReadable('<div></div>')).toEqual({ title: null, blocks: [] });
  });
});
