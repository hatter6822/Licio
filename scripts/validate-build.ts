// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'node-html-parser';

const DIST_DIR = resolve(import.meta.dirname, '..', 'apps', 'web', 'dist');
const INDEX_HTML = resolve(DIST_DIR, 'index.html');

// Match ANY inline event-handler attribute (`on…`), not a fixed enumeration —
// a hand-listed set silently misses newer handlers (onpointerdown, ontoggle,
// onbeforetoggle, onanimationend, …). `on` + word chars covers every HTML on*
// event attribute.
const EVENT_HANDLER_ATTR = /^on[a-z]+$/;

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
      if (EVENT_HANDLER_ATTR.test(attr.toLowerCase())) {
        errors.push(
          `Event handler attribute on <${el.tagName.toLowerCase()}>: ${attr}="${el.getAttribute(attr)}"`,
        );
      }
    }
  }

  const DANGEROUS_SCHEMES = ['javascript:', 'data:', 'vbscript:'];

  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    const hrefLower = href.toLowerCase().trimStart();
    for (const scheme of DANGEROUS_SCHEMES) {
      if (hrefLower.startsWith(scheme)) {
        errors.push(`${scheme} URL found in <a>: ${href.slice(0, 80)}`);
      }
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
