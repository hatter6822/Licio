// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Typed client flows for the WS-D auth surface (/v1/auth/*).  Each flow drives
// the full ceremony (options → browser credential API → verify) and resolves to
// the non-sensitive UserContext the auth store persists.  Every response passes
// through zod before use (WS-C.1.2), and ceremony OUTPUT is validated through
// the same shared schema the server validates against — so a malformed
// credential fails here, not as a server 400.  The session token itself never
// appears in this module: it rides in the HttpOnly cookie set by the BFF.
//
// Anti-enumeration note: /register answers identically whether or not the email
// already had an account (the existing owner is notified out-of-band), so
// `registerWithEmail` resolves the outcome from the client's OWN session status
// afterwards, never from a distinguishable response.
import {
  type AuthSessionResult,
  authSessionResultSchema,
  genericAckSchema,
  registeredAgeBandSchema,
  sessionListResponseSchema,
  type UserContext,
  userContextSchema,
  webauthnAuthenticationResponseSchema,
  webauthnRegistrationResponseSchema,
} from '@licio/shared';
import { z } from 'zod';
import { client, fetchAuthStatus, parseResponse } from './api.js';
import { createPasskey, getPasskeyAssertion } from './webauthn.js';

// The options bodies are library-shaped (the server's @simplewebauthn output);
// validate the load-bearing structure and pass the rest through untouched.
const creationOptionsSchema = z
  .object({
    challenge: z.string().min(1),
    user: z
      .object({ id: z.string().min(1), name: z.string(), displayName: z.string() })
      .passthrough(),
  })
  .passthrough();
const requestOptionsSchema = z.object({ challenge: z.string().min(1) }).passthrough();

/** Map the echoed public user to the persistable, non-sensitive context. */
export function toUserContext(user: AuthSessionResult['user']): UserContext {
  return userContextSchema.parse({
    id: user.user_id,
    handle: user.handle,
    display_name: user.display_name,
    account_state: user.account_state,
    locale: user.locale ?? 'en-US',
  });
}

export interface SignupProfile {
  handle: string;
  display_name: string;
  /** YYYY-MM-DD; used transiently server-side for age banding, never stored. */
  date_of_birth: string;
}

// --- Email one-time-code login (WS-D.1.4a) ----------------------------------

/** Request a sign-in code.  Resolves identically whether the email exists. */
export async function startEmailLogin(email: string): Promise<void> {
  const res = await client.v1.auth.email.start.$post({ json: { email } });
  await parseResponse(res, genericAckSchema);
}

/** Redeem the emailed code for a session. */
export async function verifyEmailLogin(code: string): Promise<UserContext> {
  const res = await client.v1.auth.email['verify-login'].$post({
    json: { code: code.trim().toUpperCase() },
  });
  return toUserContext((await parseResponse(res, authSessionResultSchema)).user);
}

// --- Passkey login (WS-D.1.3a) -----------------------------------------------

/** Discoverable-credential passkey sign-in. */
export async function loginWithPasskey(): Promise<UserContext> {
  const optionsRes = await client.v1.auth.webauthn.authenticate.options.$post();
  const options = await parseResponse(optionsRes, requestOptionsSchema);
  const assertion = await getPasskeyAssertion(
    options as unknown as PublicKeyCredentialRequestOptionsJSON,
  );
  const verifyRes = await client.v1.auth.webauthn.authenticate.verify.$post({
    json: { response: webauthnAuthenticationResponseSchema.parse(assertion) },
  });
  return toUserContext((await parseResponse(verifyRes, authSessionResultSchema)).user);
}

// --- Passkey-first signup (WS-D.1.2b) ----------------------------------------

/** Create a passkey-only account (no email PII at all). */
export async function signupWithPasskey(profile: SignupProfile): Promise<UserContext> {
  const optionsRes = await client.v1.auth.webauthn.signup.options.$post({ json: profile });
  const options = await parseResponse(optionsRes, creationOptionsSchema);
  const attestation = await createPasskey(
    options as unknown as PublicKeyCredentialCreationOptionsJSON,
  );
  const verifyRes = await client.v1.auth.webauthn.signup.verify.$post({
    json: { response: webauthnRegistrationResponseSchema.parse(attestation) },
  });
  return toUserContext((await parseResponse(verifyRes, authSessionResultSchema)).user);
}

// --- Passwordless email registration (WS-D.1.2a) ------------------------------

export interface EmailRegistrationOutcome {
  /** Set when the registration minted a session (the normal path). */
  user: UserContext | null;
}

/**
 * Register with handle + email.  The server's response is enumeration-safe, so
 * the outcome is read from our OWN session status: a session means the account
 * was created and is signed in (a verification code is already in the inbox);
 * no session means the address may already belong to an account — the page
 * shows the same neutral guidance either way.
 */
export async function registerWithEmail(
  input: SignupProfile & { email: string },
): Promise<EmailRegistrationOutcome> {
  const res = await client.v1.auth.register.$post({ json: input });
  await parseResponse(res, registeredAgeBandSchema);
  const status = await fetchAuthStatus();
  return { user: status.authenticated ? status.user : null };
}

// --- Session sign-out (WS-D.1.3c) ----------------------------------------------

/**
 * Revoke the CURRENT session server-side (the BFF clears the cookie).
 * Best-effort by design: the caller clears local state regardless, and an
 * unreachable server must never trap the user in a signed-in UI.
 */
export async function revokeCurrentSession(): Promise<void> {
  const listRes = await client.v1.auth.sessions.$get();
  const { sessions } = await parseResponse(listRes, sessionListResponseSchema);
  const current = sessions.find((s) => s.current);
  if (!current) return;
  await client.v1.auth.sessions[':ref'].$delete({ param: { ref: current.session_ref } });
}
