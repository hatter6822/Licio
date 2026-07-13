-- WS-H.4.3d retirement: retire the SCOI moderator context-action store.
--
-- The merge/annotate/separate steward surface was removed (it had no
-- reader-facing consumer; its SCOI before/after measurement fed nothing but
-- its own rows), so the operational table goes with it.  The identity audit
-- row every action also wrote (`audit_log.event_type =
-- 'scoi_context_action'`) records WHO acted on WHAT, but its minimized
-- context allowlist (§19.1 redactContext) deliberately dropped the action
-- kind, reason code, annotation, and SCOI before/after — so on a deployment
-- that ever used the endpoint, THIS table is the only durable copy of those
-- appeal-relevant details.  Therefore: a POPULATED table is archived under a
-- retired name (kept readable for audit/appeal archaeology, referenced by no
-- code), and only an EMPTY table is dropped.  Fresh databases and
-- deployments that never used the surface end up with no table at all.
--
-- NO wallet/payment/treasury/financial column appears here (SPEC §21.5/§13.6).
DO $$
BEGIN
  IF to_regclass('scoi_context_actions') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "scoi_context_actions" LIMIT 1) THEN
      ALTER TABLE "scoi_context_actions" RENAME TO "scoi_context_actions_retired";
    ELSE
      DROP TABLE "scoi_context_actions";
    END IF;
  END IF;
END $$;
