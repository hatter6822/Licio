// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

export const serverEnvSchema = z.object({
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid URL' }),
  REDIS_URL: z.string().url({ message: 'REDIS_URL must be a valid URL' }),
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CORS_ORIGIN: z.string().url({ message: 'CORS_ORIGIN must be a valid URL' }),
  SESSION_SECRET: z.string().min(32, { message: 'SESSION_SECRET must be at least 32 characters' }),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function validateServerEnv(env: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Server environment validation failed:\n${formatted}`);
  }
  return result.data;
}
