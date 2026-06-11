// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fail-closed pipeline behavior WITHOUT a DOM (WS-G.4.2b).  In plain Node,
// DOMPurify exposes no sanitize function at all, so renderUGC must degrade
// to fully-escaped plain text — formatting lost, safety kept.  It must NEVER
// return serializer output that DOMPurify has not verified.
import { afterEach, describe, expect, it } from 'vitest';
import { getUgcSanitizer, resetUgcSanitizerForTests } from '../ugc/dompurify.js';
import { renderUGCDetailed } from '../ugc/render.js';

afterEach(() => resetUgcSanitizerForTests());

describe('WS-G.4.2b renderUGC without a DOM (fail-closed)', () => {
  it('has no sanitizer in plain Node', () => {
    expect(getUgcSanitizer()).toBeNull();
  });

  it('degrades to escaped plain text — never unsanitized markup', () => {
    const result = renderUGCDetailed('# Title\n\n<script>alert(1)</script> **bold**');
    expect(result.degraded).toBe(true);
    const html = String(result.html);
    // No markup of any kind: even the pipeline's own tags are absent.
    expect(html).not.toContain('<');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('# Title'); // raw markdown text, escaped
  });

  it('still bounds oversized input in degraded mode', () => {
    const result = renderUGCDetailed('a'.repeat(60_000));
    expect(result.degraded).toBe(true);
    expect(String(result.html).length).toBeLessThanOrEqual(50_000);
  });
});
