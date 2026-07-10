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

/** The SES mailer group is all-or-none for the same reason. */
const SES_REQUIRED_KEYS = [
  'SES_REGION',
  'SES_ACCESS_KEY_ID',
  'SES_SECRET_ACCESS_KEY',
  'SES_FROM_ADDRESS',
] as const;

/** The self-hosted embedding-service group is all-or-none (WS-F.3.2a). */
const EMBEDDING_REQUIRED_KEYS = [
  'EMBEDDING_URL',
  'EMBEDDING_MODEL',
  'EMBEDDING_MODEL_VERSION',
  'EMBEDDING_DIMENSION',
] as const;

/** The WS-L knomosis-gateway transport is all-or-none: a URL with no token file
 *  (or vice versa) is a deployment typo that would silently leave the gateway
 *  null and degrade every submission/standing read closed, so reject it at
 *  startup rather than at first use. */
const KNOMOSIS_GATEWAY_REQUIRED_KEYS = [
  'KNOMOSIS_GATEWAY_URL',
  'KNOMOSIS_GATEWAY_TOKEN_FILE',
] as const;

/** Report a partial all-or-none env group as a validation issue. */
function refineGroup(
  env: Record<string, unknown>,
  ctx: z.RefinementCtx,
  keys: readonly string[],
  group: string,
): void {
  const present = keys.filter((k) => env[k] !== undefined);
  if (present.length > 0 && present.length < keys.length) {
    const missing = keys.filter((k) => env[k] === undefined);
    ctx.addIssue({
      code: 'custom',
      message: `Incomplete ${group} configuration: missing ${missing.join(', ')} (set the whole group or none of it)`,
      path: [missing[0] ?? group],
    });
  }
}

export const serverEnvSchema = z.object({
  // Postgres + Redis are REQUIRED in production (enforced in the refinement
  // below). In development/test they are OPTIONAL: when unset the API boots on
  // its in-memory stores (zero-setup `pnpm dev` with seeded demo data), and
  // setting either switches that subsystem to the durable adapter.
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid URL' }).optional(),
  REDIS_URL: z.string().url({ message: 'REDIS_URL must be a valid URL' }).optional(),
  PORT: z.coerce.number().int().positive().default(3001),
  // REQUIRED (no default): a production deploy must set this explicitly, so a
  // missing NODE_ENV can never silently select the relaxed dev posture below.
  // The dev script sets NODE_ENV=development.
  NODE_ENV: z.enum(['development', 'production', 'test']),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Required in production; in dev/test a localhost default is filled below.
  CORS_ORIGIN: z.string().url({ message: 'CORS_ORIGIN must be a valid URL' }).optional(),
  // Required in production; in dev/test a fixed non-secret dev value is filled
  // below (never reachable in production — the refinement requires a real one).
  SESSION_SECRET: z
    .string()
    .min(32, { message: 'SESSION_SECRET must be at least 32 characters' })
    .optional(),
  // Optional per-chain JSON-RPC endpoints for contract-wallet (EIP-1271/6492)
  // sign-in verification, as JSON: {"1":"https://...","8453":"https://..."}.
  // When unset, only EOA wallet sign-in is available.
  CHAIN_RPC_URLS: z.string().optional(),
  // WS-L knomosis-gateway service transport (BFF → gateway, contract v0.4).
  // ALL-OR-NONE: when unset, no HTTP gateway is configured — in development a
  // deterministic in-memory fake serves the local pinned deployment; in
  // production every gateway consumer degrades CLOSED (submission rejected,
  // standing unavailable).  The bearer token is FILE-loaded (never inline env,
  // never logged).
  KNOMOSIS_GATEWAY_URL: z
    .string()
    .url({ message: 'KNOMOSIS_GATEWAY_URL must be a valid URL' })
    .optional(),
  KNOMOSIS_GATEWAY_TOKEN_FILE: z.string().min(1).optional(),
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
  // SES mailer (WS-D email delivery): the production binding behind the
  // fail-closed Mailer interface. ALL-OR-NONE (refined below): when unset,
  // production refuses to boot unless ALLOW_INSECURE_NULL_MAILER=true
  // (passkey/wallet-only deployments). SES_ENDPOINT overrides the regional
  // default for tests/local stacks.
  SES_REGION: z.string().min(1).optional(),
  SES_ACCESS_KEY_ID: z.string().min(1).optional(),
  SES_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  SES_FROM_ADDRESS: z.string().min(3).optional(),
  SES_ENDPOINT: z.string().url({ message: 'SES_ENDPOINT must be a valid URL' }).optional(),
  // Attention-ingestion per-user rate limits (WS-E.1.3c): env-driven so the
  // budgets are changeable without a redeploy. The client uploads on a 30 s
  // batched cadence (WS-C.4.4) = 2 req/min, 120 req/hr in steady state — so the
  // budget MUST sit ABOVE that, with headroom for the page-hide durable flush
  // replayed on next open, the post-submit queue drain, and a few concurrent
  // tabs/devices (the limit is per-ACCOUNT, not per-tab/IP — §19.1). A budget at
  // exactly the cadence (the former 120/hr) left zero slack and spuriously 429'd
  // legitimate readers. 30/min + 600/hr keeps a firm per-account gate (each
  // request is one coalesced, idempotent, deduped batch) with ~5x headroom.
  EVENTS_RATE_PER_MINUTE: z.coerce.number().int().positive().default(30),
  EVENTS_RATE_PER_HOUR: z.coerce.number().int().positive().default(600),
  // Self-hosted embedding service (WS-F.3.2a, SPEC §19.1: no mandatory
  // EXTERNAL embedding API — content text must not leak to a third party).
  // ALL-OR-NONE (refined below): when the group is unset, the deterministic
  // local lexical provider is used (dev/CI; warned in production because it is
  // NOT a semantic model — see apps/api/src/ingestion/embeddings.ts).
  EMBEDDING_URL: z.string().url({ message: 'EMBEDDING_URL must be a valid URL' }).optional(),
  EMBEDDING_MODEL: z.string().min(1).optional(),
  EMBEDDING_MODEL_VERSION: z.string().min(1).optional(),
  EMBEDDING_DIMENSION: z.coerce.number().int().min(8).max(4096).optional(),
  // WS-U ADR-9 LLM-backed governance NL provider (the ADR-3 seam behind the
  // in-room agent's advisory lawmaking summary). EXPLICIT OPT-IN, available in
  // every environment including production (the 2026-07-09 maintainer
  // decision) — never mandatory, never silent, always fail-closed to the
  // deterministic summariser. Backends:
  //   anthropic — hosted Claude API; requires ANTHROPIC_API_KEY (server-side
  //               only, never VITE_-prefixed, never in any client bundle).
  //               Enabling it sends governed-room proposal text off-host,
  //               making the vendor an operator-chosen data processor — boot
  //               logs this loudly.
  //   local     — an operator-run SAME-HOST inference server speaking the
  //               OpenAI-compatible /chat/completions protocol (llama.cpp
  //               server, Ollama, vLLM, LM Studio); requires
  //               GOVERNANCE_LLM_LOCAL_URL (LOOPBACK-ONLY, so "local" provably
  //               means no third-party egress; e.g. http://127.0.0.1:11434/v1)
  //               and GOVERNANCE_LLM_MODEL (the runtime's model name).
  // Absent (or 'deterministic') ⇒ the deterministic provider and zero egress.
  GOVERNANCE_LLM_PROVIDER: z.enum(['deterministic', 'anthropic', 'local']).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  GOVERNANCE_LLM_MODEL: z.string().min(1).optional(),
  GOVERNANCE_LLM_LOCAL_URL: z
    .string()
    .url({ message: 'GOVERNANCE_LLM_LOCAL_URL must be a valid URL' })
    .optional(),
  // WS-U ADR-9: when an LLM backend is enabled, the LLM is the in-room
  // moderation MODEL (bounded by the deterministic wrapper). Set `off` to keep
  // the deterministic default moderation proposer even with a backend
  // configured (the backend then serves only the summary surface). No effect
  // without a backend.
  GOVERNANCE_LLM_MODERATION: z.enum(['on', 'off']).optional(),
});

/** True for an http(s) URL whose host is the loopback interface — the rule
 *  that makes the 'local' LLM backend provably same-host (no third-party
 *  egress). Exported for the boot-time decision (apps/api) so the env
 *  refinement and the runtime enforce the SAME predicate. */
export function isLoopbackHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/** Infrastructure + secrets that MUST be configured in production but may be
 *  omitted in development/test (where the in-memory stores + dev defaults take
 *  over). Listed here so the refinement and the dev-default transform agree. */
const PRODUCTION_REQUIRED_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'CORS_ORIGIN',
  'SESSION_SECRET',
] as const;

/** A fixed, NON-SECRET development session secret. It is only ever applied when
 *  NODE_ENV !== 'production' (production requires a real one, below), so it can
 *  never sign a production session. 32+ chars to satisfy the field constraint. */
const DEV_SESSION_SECRET = 'licio-development-only-insecure-session-secret';
const DEV_CORS_ORIGIN = 'http://localhost:5173';

/**
 * Rejects a PARTIAL S3/SES/EMBEDDING group (a typo'd deployment silently
 * falling back would discard data), AND requires the full infrastructure +
 * secret set in production. Then fills dev/test defaults for the secret + CORS
 * origin so a zero-config `pnpm dev` boots (Postgres/Redis simply stay unset and
 * the in-memory stores serve).
 */
export const serverEnvSchemaRefined = serverEnvSchema
  .superRefine((env, ctx) => {
    refineGroup(env, ctx, S3_REQUIRED_KEYS, 'S3');
    refineGroup(env, ctx, SES_REQUIRED_KEYS, 'SES');
    refineGroup(env, ctx, EMBEDDING_REQUIRED_KEYS, 'EMBEDDING');
    refineGroup(env, ctx, KNOMOSIS_GATEWAY_REQUIRED_KEYS, 'KNOMOSIS_GATEWAY');
    // WS-U ADR-9: an LLM-backend opt-in enforces that backend's requirements
    // at startup in every environment (fail-fast, never a silent boot with a
    // half-configured backend that would then silently serve deterministic).
    if (env.GOVERNANCE_LLM_PROVIDER === 'anthropic' || env.GOVERNANCE_LLM_PROVIDER === 'local') {
      if (env.GOVERNANCE_LLM_PROVIDER === 'anthropic') {
        // Reject a blank (whitespace-only) key too: it passes an undefined-only
        // check but `resolveGovernanceLlmDecision` trims it to empty and silently
        // disables the backend — turning an explicit opt-in into a silent
        // deterministic boot. Fail fast instead (a half-configured backend).
        if (env.ANTHROPIC_API_KEY === undefined || env.ANTHROPIC_API_KEY.trim() === '') {
          ctx.addIssue({
            code: 'custom',
            message: 'GOVERNANCE_LLM_PROVIDER=anthropic requires a non-empty ANTHROPIC_API_KEY',
            path: ['ANTHROPIC_API_KEY'],
          });
        }
        // GOVERNANCE_LLM_MODEL is OPTIONAL for anthropic (defaults to the reviewed
        // model), but a blank explicit override is silently trimmed to empty and
        // falls back to the default — an explicit-yet-invalid value that must fail
        // fast, not be ignored. (The `local` branch already requires it non-blank.)
        if (env.GOVERNANCE_LLM_MODEL !== undefined && env.GOVERNANCE_LLM_MODEL.trim() === '') {
          ctx.addIssue({
            code: 'custom',
            message: 'GOVERNANCE_LLM_MODEL must be non-empty when set',
            path: ['GOVERNANCE_LLM_MODEL'],
          });
        }
      } else {
        if (env.GOVERNANCE_LLM_LOCAL_URL === undefined) {
          ctx.addIssue({
            code: 'custom',
            message: 'GOVERNANCE_LLM_PROVIDER=local requires GOVERNANCE_LLM_LOCAL_URL',
            path: ['GOVERNANCE_LLM_LOCAL_URL'],
          });
        } else if (!isLoopbackHttpUrl(env.GOVERNANCE_LLM_LOCAL_URL)) {
          ctx.addIssue({
            code: 'custom',
            message:
              'GOVERNANCE_LLM_LOCAL_URL must point at the loopback interface (localhost / 127.0.0.1 / [::1]) — a non-local URL is third-party egress and belongs to the anthropic backend decision, not local',
            path: ['GOVERNANCE_LLM_LOCAL_URL'],
          });
        }
        // Reject a blank model name too (same silent-disable trap as the key).
        if (env.GOVERNANCE_LLM_MODEL === undefined || env.GOVERNANCE_LLM_MODEL.trim() === '') {
          ctx.addIssue({
            code: 'custom',
            message:
              'GOVERNANCE_LLM_PROVIDER=local requires a non-empty GOVERNANCE_LLM_MODEL (the local runtime model name)',
            path: ['GOVERNANCE_LLM_MODEL'],
          });
        }
      }
    }
    if (env.NODE_ENV === 'production') {
      for (const key of PRODUCTION_REQUIRED_KEYS) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `${key} is required in production`,
            path: [key],
          });
        }
      }
    }
  })
  .transform((env) => ({
    ...env,
    // Non-production only: production reached the refinement above with both set.
    SESSION_SECRET: env.SESSION_SECRET ?? DEV_SESSION_SECRET,
    CORS_ORIGIN: env.CORS_ORIGIN ?? DEV_CORS_ORIGIN,
  }));

export type ServerEnv = z.infer<typeof serverEnvSchemaRefined>;

export function validateServerEnv(env: Record<string, string | undefined>): ServerEnv {
  return serverEnvSchemaRefined.parse(env);
}
