import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseServerEnv, type ServerEnv } from '@licio/shared/env/server';

const developmentDefaults = {
  CORS_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://licio:licio@localhost:5432/licio',
  LOG_LEVEL: 'info',
  NODE_ENV: 'development',
  PORT: '3001',
  REDIS_URL: 'redis://localhost:6379',
} satisfies Record<string, string>;

function repositoryRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    current = dirname(current);
  }
  return process.cwd();
}

function stripOptionalQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseDotEnv(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const assignment = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separatorIndex = assignment.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = assignment.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    parsed[key] = stripOptionalQuotes(assignment.slice(separatorIndex + 1));
  }
  return parsed;
}

function loadDotEnvFiles(root: string): Record<string, string> {
  const loaded: Record<string, string> = {};
  for (const fileName of ['.env', '.env.local']) {
    const filePath = join(root, fileName);
    if (!existsSync(filePath)) {
      continue;
    }
    Object.assign(loaded, parseDotEnv(readFileSync(filePath, 'utf8')));
  }
  return loaded;
}

export function loadServerEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  root: string = repositoryRoot(),
): ServerEnv {
  const fileEnv = loadDotEnvFiles(root);
  const { NODE_ENV: baseNodeEnv } = baseEnv;
  const { NODE_ENV: fileNodeEnv } = fileEnv;
  const requestedNodeEnv = baseNodeEnv ?? fileNodeEnv ?? developmentDefaults.NODE_ENV;
  const generatedDevelopmentSecret = randomBytes(32).toString('base64url');
  const safeDevelopmentDefaults =
    requestedNodeEnv === 'production'
      ? {}
      : { ...developmentDefaults, SESSION_SECRET: generatedDevelopmentSecret };

  return parseServerEnv({ ...safeDevelopmentDefaults, ...fileEnv, ...baseEnv });
}
