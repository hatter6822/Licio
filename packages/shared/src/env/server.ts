import { z } from 'zod';

const nodeEnvironmentSchema = z.enum(['development', 'production', 'test']);

export const serverEnvSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    PORT: z.coerce.number().int().positive().max(65_535).default(3001),
    NODE_ENV: nodeEnvironmentSchema.default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    CORS_ORIGIN: z.string().url(),
    SESSION_SECRET: z
      .string()
      .min(32)
      .refine((value) => value !== 'replace-with-at-least-32-characters', {
        message: 'SESSION_SECRET must be a real, deployment-specific secret',
      }),
  })
  .strict();

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(env: NodeJS.ProcessEnv): ServerEnv {
  const { CORS_ORIGIN, DATABASE_URL, LOG_LEVEL, NODE_ENV, PORT, REDIS_URL, SESSION_SECRET } = env;
  return serverEnvSchema.parse({
    CORS_ORIGIN,
    DATABASE_URL,
    LOG_LEVEL,
    NODE_ENV,
    PORT,
    REDIS_URL,
    SESSION_SECRET,
  });
}
