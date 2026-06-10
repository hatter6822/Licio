// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

/** The S3 group is all-or-none; a partial group is a deployment mistake. */
const S3_REQUIRED_KEYS = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;

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
  // S3-compatible object storage for DSAR export archives (WS-D.2.2c): AWS
  // S3, Cloudflare R2, or MinIO. ALL-OR-NONE (refined below): when the group
  // is unset, exports use the in-memory store (dev/CI; warned in production —
  // archives then do not survive a restart). Archives are SecretBox-encrypted
  // client-side regardless, so confidentiality never depends on the bucket.
  S3_ENDPOINT: z.string().url({ message: 'S3_ENDPOINT must be a valid URL' }).optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_PREFIX: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Rejects a PARTIAL S3 group: silently falling back to the in-memory store
 *  on a typo'd deployment would discard export archives on every restart. */
export const serverEnvSchemaRefined = serverEnvSchema.superRefine((env, ctx) => {
  const present = S3_REQUIRED_KEYS.filter((k) => env[k] !== undefined);
  if (present.length > 0 && present.length < S3_REQUIRED_KEYS.length) {
    const missing = S3_REQUIRED_KEYS.filter((k) => env[k] === undefined);
    ctx.addIssue({
      code: 'custom',
      message: `Incomplete S3 configuration: missing ${missing.join(', ')} (set the whole S3_* group or none of it)`,
      path: [missing[0] ?? 'S3_ENDPOINT'],
    });
  }
});

export function validateServerEnv(env: Record<string, string | undefined>): ServerEnv {
  return serverEnvSchemaRefined.parse(env);
}
