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
  // Optional per-chain JSON-RPC endpoints for contract-wallet (EIP-1271/6492)
  // sign-in verification, as JSON: {"1":"https://...","8453":"https://..."}.
  // When unset, only EOA wallet sign-in is available.
  CHAIN_RPC_URLS: z.string().optional(),
  // Web Push / VAPID (WS-C.2.4a). All optional: when unset, push is disabled and
  // the push endpoints report unconfigured rather than failing. The private key
  // lives ONLY here (server env), never in the client bundle (SPEC §6.8, §21.2).
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:\/\/)/, {
      message: 'VAPID_SUBJECT must be a mailto: or https:// URI',
    })
    .optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function validateServerEnv(env: Record<string, string | undefined>): ServerEnv {
  return serverEnvSchema.parse(env);
}
