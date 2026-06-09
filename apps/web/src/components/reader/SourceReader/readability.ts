// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Readability extraction (WS-B.2.7). A dependency-free, DOM-free heuristic that
// pulls the main article content out of (already DOMPurify-sanitized) HTML and
// returns it as structured TEXT blocks. Being string-only, it is safe to run in
// a Web Worker (no DOM APIs) and the component renders the result through React
// (auto-escaped) — so no remote markup is ever executed.

export interface ReadableBlock {
  type: 'heading' | 'paragraph' | 'listitem';
  /** Heading rank within the reader (2 = section, 3 = sub-section). */
  level: 2 | 3;
  text: string;
}

export interface ReadableContent {
  title: string | null;
  blocks: ReadableBlock[];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith('#')) {
      const isHex = code[1] === 'x' || code[1] === 'X';
      const num = Number.parseInt(isHex ? code.slice(2) : code.slice(1), isHex ? 16 : 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : match;
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named ?? match;
  });
}

/** Strip tags + decode entities + collapse whitespace to a clean text run. */
function cleanText(htmlFragment: string): string {
  return decodeEntities(htmlFragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove boilerplate / non-content regions before extracting. */
function stripBoilerplate(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<(script|style|noscript|nav|header|footer|aside|form|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi,
      ' ',
    );
}

/**
 * Extract the readable content of a sanitized HTML document. Prefers an
 * `<article>` / `<main>` region when present, then collects headings,
 * paragraphs, and list items in document order.
 */
export function extractReadable(rawHtml: string): ReadableContent {
  const html = stripBoilerplate(rawHtml);

  const titleMatch =
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const title = titleMatch ? cleanText(titleMatch[1] ?? '') || null : null;

  const region =
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ??
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
    html;

  const blocks: ReadableBlock[] = [];
  const blockPattern = /<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match = blockPattern.exec(region);
  while (match !== null) {
    const tag = (match[1] ?? '').toLowerCase();
    const text = cleanText(match[2] ?? '');
    if (text) {
      if (tag.startsWith('h')) {
        const rank = Number(tag.slice(1));
        blocks.push({ type: 'heading', level: rank <= 2 ? 2 : 3, text });
      } else if (tag === 'li') {
        blocks.push({ type: 'listitem', level: 3, text });
      } else {
        blocks.push({ type: 'paragraph', level: 2, text });
      }
    }
    match = blockPattern.exec(region);
  }

  return { title, blocks };
}
