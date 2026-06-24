-- WS-S.9 (PRIVATE_SPEC §24, phases 5–6) — the server-room → Private-P2P-room
-- migration freeze flag.  A Members-only server room is set FROZEN read-only
-- during/after migration: new submissions and contributions are rejected
-- (fail-closed at the service layer), while existing content stays readable
-- until the phase-6 purge.  `migrated_to_room_id` is the OPAQUE client-side P2P
-- room id (a UUID, NOT a server FK — a Private P2P room never has a server row)
-- the old room points at, surfaced honestly in the §8 disclosure.  Additive,
-- column-only: existing rooms default to `frozen = false` (never read-only).
ALTER TABLE "rooms" ADD COLUMN "frozen" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "migrated_to_room_id" text;
