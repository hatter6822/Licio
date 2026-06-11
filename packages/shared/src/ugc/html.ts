// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UGC AST → constrained HTML serializer (WS-G.4.1 → WS-G.4.2a hand-off).
// Emits ONLY the WS-G.4.2a allow-list — p, h1–h3, strong, em, code, pre, a,
// blockquote, ul, ol, li, br — with `href` as the single attribute.  Every
// text value passes through {@link escapeHtml}; href values additionally pass
// attribute escaping.  The serializer cannot emit an element outside the
// table below, so even before DOMPurify runs the string contains no script,
// no event handler, and no dangerous URL (the parser already normalized
// schemes).  DOMPurify (WS-G.4.2a) then re-verifies independently.
import type { UgcBlockNode, UgcDocument, UgcInlineNode } from './markdown.js';

/** Escape text for an HTML text-node position. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a URL for a double-quoted attribute position. */
function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function serializeInline(nodes: readonly UgcInlineNode[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += escapeHtml(node.value);
        break;
      case 'softbreak':
        out += '<br>';
        break;
      case 'strong':
        out += `<strong>${serializeInline(node.children)}</strong>`;
        break;
      case 'em':
        out += `<em>${serializeInline(node.children)}</em>`;
        break;
      case 'code':
        out += `<code>${escapeHtml(node.value)}</code>`;
        break;
      case 'link':
        out += `<a href="${escapeAttribute(node.href)}">${serializeInline(node.children)}</a>`;
        break;
    }
  }
  return out;
}

function serializeBlock(block: UgcBlockNode): string {
  switch (block.kind) {
    case 'paragraph':
      return `<p>${serializeInline(block.children)}</p>`;
    case 'heading':
      return `<h${block.level}>${serializeInline(block.children)}</h${block.level}>`;
    case 'code_block':
      return `<pre><code>${escapeHtml(block.value)}</code></pre>`;
    case 'blockquote':
      return `<blockquote>${block.children.map(serializeBlock).join('')}</blockquote>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map((item) => `<li>${serializeInline(item)}</li>`).join('');
      return `<${tag}>${items}</${tag}>`;
    }
  }
}

/** Serialize a parsed UGC document into the constrained HTML string. */
export function serializeUgcDocument(document: UgcDocument): string {
  return document.blocks.map(serializeBlock).join('');
}
