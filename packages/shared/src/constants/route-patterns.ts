// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The canonical route-PATTERN catalog (SSOT): the TanStack route ids the PWA
// can report as a telemetry bucket (WS-P.1.1d per-route Web Vitals).  The API
// normalizes the unauthenticated beacon's `bucket` against this closed set —
// anything else (a concrete path, a handle, a slug, a forged string) buckets
// as 'unknown' and can never persist into the 90-day per-route series.
// apps/web's drift test asserts this list equals the generated route tree, so
// adding a route without updating this catalog fails CI.
export const ROUTE_PATTERNS = [
  '/',
  '/compliance-console',
  '/debate/$debateId',
  '/dev/simulator',
  '/login',
  '/migrate',
  '/moderation',
  '/private',
  '/private/',
  '/private_/$roomId',
  '/private/migrate',
  '/profile',
  '/profile_/mode',
  '/profile_/notices',
  '/profile_/offline',
  '/profile_/privacy',
  '/profile_/safety',
  '/profile_/saved',
  '/profile_/security',
  '/profile_/settings',
  '/profile_/signal-ledger',
  '/profile_/wallet',
  '/rooms',
  '/rooms_/$roomId',
  '/rooms_/$roomId_/governance',
  '/stories/$storyId',
  '/stories/$storyId_/comments',
  '/stories/$storyId/debate/$debateId',
  '/styleguide',
  '/submit',
  '/support',
  '/threads_/$threadId',
] as const;

export const ROUTE_PATTERN_SET: ReadonlySet<string> = new Set(ROUTE_PATTERNS);
