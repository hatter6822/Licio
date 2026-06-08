import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { contentSecurityPolicy, permissionsPolicy } from '../../apps/api/src/security/headers.js';

const distDir = resolve(process.cwd(), 'apps/web/dist');
const port = Number(process.env.PORT ?? 4173);
const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function securityHeaders() {
  return {
    'Content-Security-Policy': contentSecurityPolicy,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': permissionsPolicy,
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
  };
}

const server = createServer(async (request, response) => {
  const requestedPath = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname;
  const normalizedPath = normalize(decodeURIComponent(requestedPath)).replace(/^\/+/, '');
  const candidate = normalizedPath === '' ? 'index.html' : normalizedPath;
  const filePath = resolve(distDir, candidate);
  const relativeCandidate = relative(distDir, filePath);

  if (relativeCandidate.startsWith('..') || relativeCandidate === '..') {
    response.writeHead(403, securityHeaders()).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    response
      .writeHead(200, {
        ...securityHeaders(),
        'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
      })
      .end(body);
  } catch {
    const body = await readFile(join(distDir, 'index.html'));
    response
      .writeHead(200, { ...securityHeaders(), 'Content-Type': contentTypes['.html'] })
      .end(body);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.info(`Secure preview listening at http://127.0.0.1:${port}`);
});
