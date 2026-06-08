import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const certDir = join(process.cwd(), '.certs');
const keyPath = join(certDir, 'localhost-key.pem');
const certPath = join(certDir, 'localhost-cert.pem');

if (!existsSync(keyPath) || !existsSync(certPath)) {
  mkdirSync(certDir, { recursive: true });
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:3072',
      '-nodes',
      '-sha256',
      '-days',
      '30',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { stdio: 'inherit' },
  );
}

console.info(`Local HTTPS certificate ready at ${certPath}`);
