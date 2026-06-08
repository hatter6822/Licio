import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { bootstrapTrustedTypes, sanitizeToTrustedHtml } from './trusted-types.js';

describe('trusted types bootstrap', () => {
  it('creates restrictive default and DOMPurify policies when trusted types are available', () => {
    const policies = new Map<
      string,
      {
        createHTML?: (input: string) => string;
        createScript?: (input: string) => string;
        createScriptURL?: (input: string) => string;
      }
    >();
    const window = new JSDOM('<!doctype html><html><body></body></html>')
      .window as unknown as Window & {
      trustedTypes: {
        createPolicy: (
          name: string,
          policy: {
            createHTML?: (input: string) => string;
            createScript?: (input: string) => string;
            createScriptURL?: (input: string) => string;
          },
        ) => unknown;
      };
    };
    window.trustedTypes = {
      createPolicy(name, policy) {
        policies.set(name, policy);
        return policy;
      },
    };

    bootstrapTrustedTypes(window);

    expect(() => policies.get('default')?.createHTML?.('<p>raw</p>')).toThrow(/Raw HTML/);
    expect(() => policies.get('default')?.createScript?.('alert(1)')).toThrow(/scripts/);
    expect(() => policies.get('default')?.createScriptURL?.('/x.js')).toThrow(/script URLs/);
    expect(policies.get('dompurify')?.createHTML?.('<img src=x onerror=alert(1)>')).not.toContain(
      'onerror',
    );
  });

  it('is safe when a browser lacks trusted types support', () => {
    expect(() => bootstrapTrustedTypes({} as Window)).not.toThrow();
  });

  it('sanitizes untrusted markup', () => {
    const window = new JSDOM('<!doctype html><html><body></body></html>')
      .window as unknown as Window;
    const sanitized = sanitizeToTrustedHtml('<img src=x onerror=alert(1)><p>safe</p>', window);
    expect(String(sanitized)).toContain('<p>safe</p>');
    expect(String(sanitized)).not.toContain('onerror');
  });
});
