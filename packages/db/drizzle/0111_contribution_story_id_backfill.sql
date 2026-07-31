-- WS-E — carry `story_id` on the `contribution.created` payloads already on disk.
--
-- The field was added to the wire schema as OPTIONAL, for a sound reason: a
-- payload written by the previous release cannot have it, `recoverEventPipeline`
-- feeds every stored row back through `parseEvent`, and what fails to parse is
-- silently dropped — so requiring it in place would have made every pre-upgrade
-- contribution vanish from the replay to `ingestion-signals` and
-- `invariant-scoi-bridge`, from the real-time rebuild, and would have deleted an
-- existing dead letter as corrupt.
--
-- What that left behind is the loss this repairs.  The participation fold keys on
-- `story_id` and SKIPPED a payload without one, so every pre-upgrade contribution
-- left the durable fold — half of ConstructiveParticipation — for the whole
-- 1h/24h/7d window horizon a rolling upgrade spans, and `pwatt/scoring.ts` writes
-- Signal Ledger entries only for folded actors, so those members' own ledgers
-- never showed those contributions either.  `consumers.ts` also throws on redrive
-- telling the operator to "migrate the stored payload or resolve its story from
-- thread_id before redriving", and no such migration existed, so a dead letter
-- under `realtime-aggregation` was permanently unredrivable.  Dead letters store
-- only `event_id` and re-read the payload from `events`, so repairing `events`
-- repairs the redrive too.
--
-- The resolution was available the whole time: `threads.story_id` is NOT NULL with
-- a foreign key, and the sibling durable consumer of this exact event already
-- resolves it that way.  This repo's precedent (0076) is to repair stored payloads
-- for exactly this reason — "rows that fail parse are silently skipped — never
-- acceptable for real submissions".
--
-- Idempotent (`WHERE payload->>'story_id' IS NULL`), so re-running is a no-op, and
-- rows whose thread no longer exists are left alone rather than given a fabricated
-- id — the fold still counts those, and a wrong story id is worse than a counted
-- omission.
--
-- The wire field stays OPTIONAL after this.  Making it required is the CONTRACT
-- step of an expand/migrate/contract and belongs in a later release: during a
-- rolling upgrade an instance running the previous code is still emitting
-- payloads without it, so a required field would reject live traffic, not just
-- old rows.  Tracked in `docs/events/README.md`.
UPDATE "events" AS e
SET "payload" = jsonb_set(e."payload", '{story_id}', to_jsonb(t."story_id"::text))
FROM "threads" AS t
WHERE e."topic" = 'contribution.created'
  AND e."payload"->>'story_id' IS NULL
  AND e."payload"->>'thread_id' IS NOT NULL
  AND t."thread_id" = (e."payload"->>'thread_id')::uuid;
