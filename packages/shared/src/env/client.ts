// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

export const clientEnvSchema = z.object({
  VITE_API_URL: z.string().url({ message: 'VITE_API_URL must be a valid URL' }),
  VITE_APP_URL: z.string().url({ message: 'VITE_APP_URL must be a valid URL' }),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

export function validateClientEnv(env: Record<string, string | undefined>): ClientEnv {
  const nonViteKeys = Object.keys(env).filter(
    (key) =>
      !key.startsWith('VITE_') &&
      key !== 'BASE_URL' &&
      key !== 'MODE' &&
      key !== 'DEV' &&
      key !== 'PROD' &&
      key !== 'SSR',
  );
  if (nonViteKeys.length > 0) {
    throw new Error(
      `Client environment must only contain VITE_ prefixed variables. Found: ${nonViteKeys.join(', ')}`,
    );
  }

  const result = clientEnvSchema.safeParse(env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Client environment validation failed:\n${formatted}`);
  }
  return result.data;
}
