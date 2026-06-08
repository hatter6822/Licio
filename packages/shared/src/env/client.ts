import { z } from 'zod';

export const clientEnvSchema = z
  .object({
    VITE_API_URL: z.string().url(),
    VITE_APP_URL: z.string().url(),
  })
  .strict();

export type ClientEnv = z.infer<typeof clientEnvSchema>;

export function parseClientEnv(env: Record<string, unknown>): ClientEnv {
  const nonClientKeys = Object.keys(env).filter((key) => !key.startsWith('VITE_'));
  if (nonClientKeys.length > 0) {
    throw new Error(
      `Client environment variables must use the VITE_ prefix. Invalid keys: ${nonClientKeys.join(', ')}`,
    );
  }
  return clientEnvSchema.parse(env);
}
