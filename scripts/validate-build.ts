import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DefaultTreeAdapterMap, parse } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const indexPath = process.cwd().endsWith('apps/web')
  ? join(process.cwd(), 'dist/index.html')
  : join(process.cwd(), 'apps/web/dist/index.html');
const html = readFileSync(indexPath, 'utf8');
const document = parse(html, { sourceCodeLocationInfo: true });
const violations: string[] = [];

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function snippet(node: Element): string {
  const location = node.sourceCodeLocation;
  if (location === undefined) {
    return `<${node.tagName}>`;
  }
  return html.slice(location.startOffset, location.endOffset).slice(0, 200);
}

function visit(node: Node): void {
  if (isElement(node)) {
    const attrs = new Map(node.attrs.map((attr) => [attr.name.toLowerCase(), attr.value]));
    if (node.tagName === 'script' && !attrs.has('src')) {
      violations.push(`Inline script: ${snippet(node)}`);
    }
    if (node.tagName === 'style') {
      violations.push(`Inline style block: ${snippet(node)}`);
    }
    for (const attr of node.attrs) {
      const name = attr.name.toLowerCase();
      const value = attr.value.toLowerCase();
      if (name === 'style') {
        violations.push(`Inline style attribute: ${snippet(node)}`);
      }
      if (name.startsWith('on')) {
        violations.push(`Inline event handler: ${snippet(node)}`);
      }
      if ((name === 'href' || name === 'src') && value.trim().startsWith('javascript:')) {
        violations.push(`javascript: URL: ${snippet(node)}`);
      }
    }
  }

  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      visit(child);
    }
  }
}

visit(document);

if (violations.length > 0) {
  console.error(`Build validation failed for ${indexPath}:`);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.info(
    'Build validation passed: no inline scripts, styles, handlers, or javascript: URLs.',
  );
}
