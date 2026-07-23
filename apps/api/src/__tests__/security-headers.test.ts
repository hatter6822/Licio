// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

describe('Security headers', () => {
  const app = createApp();
  const originalCorsOrigin = process.env['CORS_ORIGIN'];

  beforeEach(() => {
    process.env['CORS_ORIGIN'] = 'https://licio.example';
  });

  afterEach(() => {
    if (originalCorsOrigin === undefined) delete process.env['CORS_ORIGIN'];
    else process.env['CORS_ORIGIN'] = originalCorsOrigin;
  });

  it('should set Content-Security-Policy with all directives', async () => {
    const res = await app.request('/health');
    const csp = res.headers.get('Content-Security-Policy');
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain('trusted-types default dompurify');
    expect(csp).toContain('report-uri /api/security/csp-report');
    expect(csp).toContain('report-to csp-endpoint');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('should set Reporting-Endpoints header', async () => {
    const res = await app.request('/health');
    const endpoints = res.headers.get('Reporting-Endpoints');
    expect(endpoints).toBe('csp-endpoint="/api/security/csp-report"');
  });

  it('should set Report-To header at the CONFIGURED canonical origin', async () => {
    const res = await app.request('/health');
    const reportTo = res.headers.get('Report-To');
    expect(reportTo).toBeDefined();
    const parsed = JSON.parse(reportTo ?? '') as {
      group: string;
      max_age: number;
      endpoints: Array<{ url: string }>;
    };
    expect(parsed.group).toBe('csp-endpoint');
    expect(parsed.max_age).toBe(86400);
    expect(parsed.endpoints[0]?.url).toBe('https://licio.example/api/security/csp-report');
  });

  // The reporting endpoint is deployment identity, and identity comes from
  // configuration — never from a header the caller controls. A poisoned shared
  // cache would otherwise point every later visitor's CSP reports (which carry
  // the document URL) at an attacker's collector for max_age seconds.
  it('ignores spoofed Host / X-Forwarded-* when building Report-To', async () => {
    const res = await app.request('/health', {
      headers: {
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      },
    });
    const reportTo = res.headers.get('Report-To') ?? '';
    expect(reportTo).not.toContain('evil.example');
    expect(reportTo).toContain('https://licio.example/api/security/csp-report');
  });

  // Unconfigured deployments must not fall back to a header-derived origin: the
  // legacy v0 header is dropped, and the two RELATIVE reporting channels every
  // current browser actually uses keep working.
  it('omits the legacy Report-To when no canonical origin is configured', async () => {
    delete process.env['CORS_ORIGIN'];
    const res = await app.request('/health', { headers: { host: 'evil.example' } });
    expect(res.headers.get('Report-To')).toBeNull();
    expect(res.headers.get('Reporting-Endpoints')).toBe('csp-endpoint="/api/security/csp-report"');
    expect(res.headers.get('Content-Security-Policy')).toContain(
      'report-uri /api/security/csp-report',
    );
  });

  it('should set Strict-Transport-Security', async () => {
    const res = await app.request('/health');
    const hsts = res.headers.get('Strict-Transport-Security');
    expect(hsts).toContain('max-age=63072000');
    expect(hsts).toContain('includeSubDomains');
    expect(hsts).toContain('preload');
  });

  it('should set X-Content-Type-Options', async () => {
    const res = await app.request('/health');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('should set X-Frame-Options', async () => {
    const res = await app.request('/health');
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
  });

  it('should set Referrer-Policy', async () => {
    const res = await app.request('/health');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('should set COOP and CORP', async () => {
    const res = await app.request('/health');
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  it('should set Permissions-Policy', async () => {
    const res = await app.request('/health');
    const pp = res.headers.get('Permissions-Policy');
    expect(pp).toContain('camera=()');
    expect(pp).toContain('microphone=()');
    expect(pp).toContain('geolocation=()');
    expect(pp).toContain('payment=()');
  });
});
