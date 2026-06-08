// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'node-html-parser';

const DIST_DIR = resolve(import.meta.dirname, '..', 'apps', 'web', 'dist');
const INDEX_HTML = resolve(DIST_DIR, 'index.html');

const EVENT_HANDLER_ATTRS = new Set([
  'onclick',
  'onload',
  'onerror',
  'onsubmit',
  'onfocus',
  'onblur',
  'onchange',
  'oninput',
  'onkeydown',
  'onkeyup',
  'onkeypress',
  'onmouseover',
  'onmouseout',
  'onmousedown',
  'onmouseup',
  'ondblclick',
  'oncontextmenu',
  'onwheel',
  'ondrag',
  'ondrop',
  'onscroll',
  'onresize',
  'ontouchstart',
  'ontouchend',
  'ontouchmove',
]);

function validate(): void {
  if (!existsSync(INDEX_HTML)) {
    console.error(`ERROR: ${INDEX_HTML} does not exist. Build first.`);
    process.exit(1);
  }

  const html = readFileSync(INDEX_HTML, 'utf-8');
  const root = parse(html);
  const errors: string[] = [];

  for (const script of root.querySelectorAll('script')) {
    if (!script.getAttribute('src') && script.textContent.trim().length > 0) {
      errors.push(`Inline <script> found: ${script.textContent.trim().slice(0, 80)}...`);
    }
  }

  for (const style of root.querySelectorAll('style')) {
    if (style.textContent.trim().length > 0) {
      errors.push(`Inline <style> found: ${style.textContent.trim().slice(0, 80)}...`);
    }
  }

  for (const el of root.querySelectorAll('*')) {
    if (el.getAttribute('style')) {
      errors.push(
        `Inline style attribute on <${el.tagName.toLowerCase()}>: style="${el.getAttribute('style')}"`,
      );
    }

    for (const attr of Object.keys(el.attributes)) {
      if (EVENT_HANDLER_ATTRS.has(attr.toLowerCase())) {
        errors.push(
          `Event handler attribute on <${el.tagName.toLowerCase()}>: ${attr}="${el.getAttribute(attr)}"`,
        );
      }
    }
  }

  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (href.toLowerCase().startsWith('javascript:')) {
      errors.push(`javascript: URL found in <a>: ${href.slice(0, 80)}`);
    }
  }

  if (errors.length > 0) {
    console.error('Build validation FAILED:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log(
    'Build validation passed: zero inline scripts, styles, event handlers, or javascript: URLs.',
  );
}

validate();
