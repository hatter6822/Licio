-- Every `timestamptz` carries the resolution this application can represent.
--
-- `timestamptz` defaults to MICROSECOND precision.  Nothing in this codebase
-- can hold one: every timestamp is produced by, and read back through, a
-- JavaScript `Date`, which is milliseconds.  The extra three digits were
-- write-only — and the mismatch was not inert.  It silently deleted rows from
-- paged reads.
--
-- A keyset cursor is a value the application read out of the column and sent
-- back (`(created_at, id) < (cursor, id)`).  Read back through a `Date` it has
-- been rounded DOWN, so it names an instant strictly BEFORE the row it came
-- from; in a descending page every row sharing that millisecond with more
-- microseconds sorts after the cursor and is skipped — permanently, because
-- the next cursor moves further away.  The id tiebreaker cannot save it: ids
-- are compared only once the timestamps compare EQUAL, which a rounded cursor
-- never does against its own row.  And the page simply comes back SHORT, which
-- is how a caller decides it has reached the end — so a moderation-notice DSAR
-- export and a room's thread scan each reported themselves complete having
-- dropped rows they never saw.
--
-- Truncating inside each query would have fixed the comparison and left the
-- cause: `date_trunc(…)` is not the indexed expression, so every paged read
-- gives up its index, and the next cursor written by hand reintroduces the bug.
-- Declaring the precision removes the unrepresentable state instead.  Postgres
-- rounds on write, the column holds exactly what a `Date` holds, and cursors go
-- back to being plain indexed comparisons.
--
-- Scope: every `timestamptz` column in every schema (public, compliance,
-- knomosis, wallet) — 252 statements over 142 tables, derived from the
-- catalogue at the head of this chain rather than hand-listed, so no column is
-- missed.  That is 252 and not 284 because the `events_*` partitions inherit
-- their columns: a child refuses `ALTER … TYPE` ("cannot alter inherited
-- column") and the parent's rewrite covers all 32 of them.  The
-- `instant()` helper (`schema/_custom.ts`) is now the ONLY way to declare one
-- and `check:timestamp-precision` fails the build on a bare `timestamp(…)`,
-- so a new column cannot land at the wrong precision.
--
-- Two operational notes.  Each `ALTER … TYPE` REWRITES its table under ACCESS
-- EXCLUSIVE — fine at this stage (pre-GA, no deployment), but this is not an
-- online migration for a populated cluster.  And the narrowing ROUNDS existing
-- values to the nearest millisecond rather than truncating, so a stored value
-- may move by up to 0.5ms and a cursor issued before this migration may skip a
-- row after it; cursors are ephemeral positions, so that resolves itself on the
-- next page request.

-- compliance.compliance_case_audit
ALTER TABLE "compliance"."compliance_case_audit" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- compliance.disclosure_acknowledgment
ALTER TABLE "compliance"."disclosure_acknowledgment" ALTER COLUMN "acknowledged_at" TYPE timestamptz(3);

-- compliance.disclosure_version
ALTER TABLE "compliance"."disclosure_version" ALTER COLUMN "published_at" TYPE timestamptz(3);

-- compliance.financial_compliance_case
ALTER TABLE "compliance"."financial_compliance_case" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "compliance"."financial_compliance_case" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- compliance.jurisdiction_feature_policy
ALTER TABLE "compliance"."jurisdiction_feature_policy" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "compliance"."jurisdiction_feature_policy" ALTER COLUMN "effective_at" TYPE timestamptz(3);

-- compliance.jurisdiction_policy_audit
ALTER TABLE "compliance"."jurisdiction_policy_audit" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- compliance.kyc_verification
ALTER TABLE "compliance"."kyc_verification" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "compliance"."kyc_verification" ALTER COLUMN "updated_at" TYPE timestamptz(3);
ALTER TABLE "compliance"."kyc_verification" ALTER COLUMN "verified_at" TYPE timestamptz(3);

-- compliance.lawful_access_request
ALTER TABLE "compliance"."lawful_access_request" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "compliance"."lawful_access_request" ALTER COLUMN "updated_at" TYPE timestamptz(3);
ALTER TABLE "compliance"."lawful_access_request" ALTER COLUMN "user_notified_at" TYPE timestamptz(3);

-- compliance.region_declaration
ALTER TABLE "compliance"."region_declaration" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "compliance"."region_declaration" ALTER COLUMN "updated_at" TYPE timestamptz(3);
ALTER TABLE "compliance"."region_declaration" ALTER COLUMN "verified_at" TYPE timestamptz(3);

-- compliance.sar_report
ALTER TABLE "compliance"."sar_report" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "compliance"."sar_report" ALTER COLUMN "filed_at" TYPE timestamptz(3);
ALTER TABLE "compliance"."sar_report" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- compliance.wallet_risk_pin
ALTER TABLE "compliance"."wallet_risk_pin" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "compliance"."wallet_risk_pin" ALTER COLUMN "released_at" TYPE timestamptz(3);

-- knomosis.action_budget
ALTER TABLE "knomosis"."action_budget" ALTER COLUMN "last_refill_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."action_budget" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- knomosis.agent_action_log
ALTER TABLE "knomosis"."agent_action_log" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- knomosis.agent_treasury_action
ALTER TABLE "knomosis"."agent_treasury_action" ALTER COLUMN "executed_at" TYPE timestamptz(3);

-- knomosis.comprehension_result
ALTER TABLE "knomosis"."comprehension_result" ALTER COLUMN "passed_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."comprehension_result" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- knomosis.delegation_record
ALTER TABLE "knomosis"."delegation_record" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."delegation_record" ALTER COLUMN "revoked_at" TYPE timestamptz(3);

-- knomosis.governance_audit_log
ALTER TABLE "knomosis"."governance_audit_log" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- knomosis.governance_challenge
ALTER TABLE "knomosis"."governance_challenge" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."governance_challenge" ALTER COLUMN "resolved_at" TYPE timestamptz(3);

-- knomosis.governance_charter_version
ALTER TABLE "knomosis"."governance_charter_version" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- knomosis.governance_delegated_unit_claim
ALTER TABLE "knomosis"."governance_delegated_unit_claim" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- knomosis.governance_proposal
ALTER TABLE "knomosis"."governance_proposal" ALTER COLUMN "challenge_window_ends_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."governance_proposal" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."governance_proposal" ALTER COLUMN "deliberation_ends_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."governance_proposal" ALTER COLUMN "eligible_basis_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."governance_proposal" ALTER COLUMN "executable_after" TYPE timestamptz(3);
ALTER TABLE "knomosis"."governance_proposal" ALTER COLUMN "executed_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."governance_proposal" ALTER COLUMN "execution_claimed_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."governance_proposal" ALTER COLUMN "voting_ends_at" TYPE timestamptz(3);

-- knomosis.governance_proposal_vote
ALTER TABLE "knomosis"."governance_proposal_vote" ALTER COLUMN "cast_at" TYPE timestamptz(3);

-- knomosis.governance_signature
ALTER TABLE "knomosis"."governance_signature" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- knomosis.knomosis_action_nonce
ALTER TABLE "knomosis"."knomosis_action_nonce" ALTER COLUMN "used_at" TYPE timestamptz(3);

-- knomosis.knomosis_action_record
ALTER TABLE "knomosis"."knomosis_action_record" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."knomosis_action_record" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- knomosis.knomosis_deployment
ALTER TABLE "knomosis"."knomosis_deployment" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- knomosis.knomosis_receipt
ALTER TABLE "knomosis"."knomosis_receipt" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."knomosis_receipt" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- knomosis.knomosis_reconciliation_result
ALTER TABLE "knomosis"."knomosis_reconciliation_result" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- knomosis.model_ratification
ALTER TABLE "knomosis"."model_ratification" ALTER COLUMN "closes_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."model_ratification" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."model_ratification" ALTER COLUMN "opens_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."model_ratification" ALTER COLUMN "settled_at" TYPE timestamptz(3);

-- knomosis.model_ratification_ballot
ALTER TABLE "knomosis"."model_ratification_ballot" ALTER COLUMN "cast_at" TYPE timestamptz(3);

-- knomosis.on_chain_event
ALTER TABLE "knomosis"."on_chain_event" ALTER COLUMN "indexed_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."on_chain_event" ALTER COLUMN "reorg_detected_at" TYPE timestamptz(3);

-- knomosis.payment_intent
ALTER TABLE "knomosis"."payment_intent" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."payment_intent" ALTER COLUMN "expires_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."payment_intent" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- knomosis.room_agent_binding
ALTER TABLE "knomosis"."room_agent_binding" ALTER COLUMN "approved_at" TYPE timestamptz(3);

-- knomosis.room_governance_model
ALTER TABLE "knomosis"."room_governance_model" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- knomosis.room_governance_profile
ALTER TABLE "knomosis"."room_governance_profile" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- knomosis.room_governance_prompt
ALTER TABLE "knomosis"."room_governance_prompt" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- knomosis.room_law_pack
ALTER TABLE "knomosis"."room_law_pack" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."room_law_pack" ALTER COLUMN "effective_at" TYPE timestamptz(3);

-- knomosis.room_pending_remoderation
ALTER TABLE "knomosis"."room_pending_remoderation" ALTER COLUMN "enqueued_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."room_pending_remoderation" ALTER COLUMN "last_attempt_at" TYPE timestamptz(3);

-- knomosis.room_readiness_attestation
ALTER TABLE "knomosis"."room_readiness_attestation" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- knomosis.room_steward_seat
ALTER TABLE "knomosis"."room_steward_seat" ALTER COLUMN "term_end" TYPE timestamptz(3);
ALTER TABLE "knomosis"."room_steward_seat" ALTER COLUMN "term_start" TYPE timestamptz(3);
ALTER TABLE "knomosis"."room_steward_seat" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- knomosis.room_treasury
ALTER TABLE "knomosis"."room_treasury" ALTER COLUMN "balances_reconciled_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."room_treasury" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- knomosis.sim_treasury
ALTER TABLE "knomosis"."sim_treasury" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- knomosis.sim_treasury_entry
ALTER TABLE "knomosis"."sim_treasury_entry" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- knomosis.steward_election
ALTER TABLE "knomosis"."steward_election" ALTER COLUMN "closes_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."steward_election" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."steward_election" ALTER COLUMN "opens_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."steward_election" ALTER COLUMN "settled_at" TYPE timestamptz(3);

-- knomosis.steward_governance_vote
ALTER TABLE "knomosis"."steward_governance_vote" ALTER COLUMN "cast_at" TYPE timestamptz(3);

-- knomosis.treasury_grant
ALTER TABLE "knomosis"."treasury_grant" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- knomosis.treasury_reconciliation_snapshot
ALTER TABLE "knomosis"."treasury_reconciliation_snapshot" ALTER COLUMN "observed_at" TYPE timestamptz(3);

-- knomosis.treasury_reservation
ALTER TABLE "knomosis"."treasury_reservation" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "knomosis"."treasury_reservation" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- knomosis.wallet_actor_mapping
ALTER TABLE "knomosis"."wallet_actor_mapping" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.account_blocks
ALTER TABLE "public"."account_blocks" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.account_mutes
ALTER TABLE "public"."account_mutes" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."account_mutes" ALTER COLUMN "expires_at" TYPE timestamptz(3);

-- public.actor_authenticity_scores
ALTER TABLE "public"."actor_authenticity_scores" ALTER COLUMN "computed_at" TYPE timestamptz(3);

-- public.actor_behavior_windows
ALTER TABLE "public"."actor_behavior_windows" ALTER COLUMN "computed_at" TYPE timestamptz(3);
ALTER TABLE "public"."actor_behavior_windows" ALTER COLUMN "window_start" TYPE timestamptz(3);

-- public.aggregation_windows
ALTER TABLE "public"."aggregation_windows" ALTER COLUMN "computed_at" TYPE timestamptz(3);
ALTER TABLE "public"."aggregation_windows" ALTER COLUMN "window_start" TYPE timestamptz(3);

-- public.ai_blocked_invocations
ALTER TABLE "public"."ai_blocked_invocations" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.ai_corrections
ALTER TABLE "public"."ai_corrections" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.ai_data_lineage
ALTER TABLE "public"."ai_data_lineage" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.ai_evaluations
ALTER TABLE "public"."ai_evaluations" ALTER COLUMN "evaluated_at" TYPE timestamptz(3);

-- public.ai_governance_advisories
ALTER TABLE "public"."ai_governance_advisories" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.ai_governance_summaries
ALTER TABLE "public"."ai_governance_summaries" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.ai_inventory_versions
ALTER TABLE "public"."ai_inventory_versions" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.ai_model_cards
ALTER TABLE "public"."ai_model_cards" ALTER COLUMN "deployed_at" TYPE timestamptz(3);
ALTER TABLE "public"."ai_model_cards" ALTER COLUMN "registered_at" TYPE timestamptz(3);

-- public.ai_moderation_decisions
ALTER TABLE "public"."ai_moderation_decisions" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.ai_output_records
ALTER TABLE "public"."ai_output_records" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.ai_review_queue
ALTER TABLE "public"."ai_review_queue" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."ai_review_queue" ALTER COLUMN "resolved_at" TYPE timestamptz(3);

-- public.ai_risk_assessments
ALTER TABLE "public"."ai_risk_assessments" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.ai_runtime_alerts
ALTER TABLE "public"."ai_runtime_alerts" ALTER COLUMN "raised_at" TYPE timestamptz(3);

-- public.ai_runtime_metrics
ALTER TABLE "public"."ai_runtime_metrics" ALTER COLUMN "recorded_at" TYPE timestamptz(3);

-- public.ai_summary_drafts
ALTER TABLE "public"."ai_summary_drafts" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.ai_summary_reports
ALTER TABLE "public"."ai_summary_reports" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.ai_sweep_cursors
ALTER TABLE "public"."ai_sweep_cursors" ALTER COLUMN "cursor_created_at" TYPE timestamptz(3);
ALTER TABLE "public"."ai_sweep_cursors" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.ai_translation_reports
ALTER TABLE "public"."ai_translation_reports" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.ai_translations
ALTER TABLE "public"."ai_translations" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.attention_aggregates
ALTER TABLE "public"."attention_aggregates" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.audit_log
ALTER TABLE "public"."audit_log" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.bridge_attempts
ALTER TABLE "public"."bridge_attempts" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."bridge_attempts" ALTER COLUMN "resolved_at" TYPE timestamptz(3);

-- public.claims
ALTER TABLE "public"."claims" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."claims" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.consumer_checkpoints
ALTER TABLE "public"."consumer_checkpoints" ALTER COLUMN "last_event_timestamp" TYPE timestamptz(3);
ALTER TABLE "public"."consumer_checkpoints" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.contribution_edit_history
ALTER TABLE "public"."contribution_edit_history" ALTER COLUMN "edited_at" TYPE timestamptz(3);

-- public.contributions
ALTER TABLE "public"."contributions" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."contributions" ALTER COLUMN "settled_at" TYPE timestamptz(3);
ALTER TABLE "public"."contributions" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.coordinated_report_incidents
ALTER TABLE "public"."coordinated_report_incidents" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."coordinated_report_incidents" ALTER COLUMN "reviewed_at" TYPE timestamptz(3);

-- public.debate_arenas
ALTER TABLE "public"."debate_arenas" ALTER COLUMN "challenger_last_active_at" TYPE timestamptz(3);
ALTER TABLE "public"."debate_arenas" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."debate_arenas" ALTER COLUMN "edit_deadline_at" TYPE timestamptz(3);
ALTER TABLE "public"."debate_arenas" ALTER COLUMN "incumbent_last_active_at" TYPE timestamptz(3);
ALTER TABLE "public"."debate_arenas" ALTER COLUMN "locked_at" TYPE timestamptz(3);
ALTER TABLE "public"."debate_arenas" ALTER COLUMN "override_deadline_at" TYPE timestamptz(3);
ALTER TABLE "public"."debate_arenas" ALTER COLUMN "resolve_due_at" TYPE timestamptz(3);
ALTER TABLE "public"."debate_arenas" ALTER COLUMN "resolved_at" TYPE timestamptz(3);
ALTER TABLE "public"."debate_arenas" ALTER COLUMN "updated_at" TYPE timestamptz(3);
ALTER TABLE "public"."debate_arenas" ALTER COLUMN "verdict_at" TYPE timestamptz(3);

-- public.deletion_requests
ALTER TABLE "public"."deletion_requests" ALTER COLUMN "cancelled_at" TYPE timestamptz(3);
ALTER TABLE "public"."deletion_requests" ALTER COLUMN "completed_at" TYPE timestamptz(3);
ALTER TABLE "public"."deletion_requests" ALTER COLUMN "purge_at" TYPE timestamptz(3);
ALTER TABLE "public"."deletion_requests" ALTER COLUMN "requested_at" TYPE timestamptz(3);

-- public.embeddings
ALTER TABLE "public"."embeddings" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."embeddings" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.event_dead_letters
ALTER TABLE "public"."event_dead_letters" ALTER COLUMN "failed_at" TYPE timestamptz(3);

-- public.events
ALTER TABLE "public"."events" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."events" ALTER COLUMN "purge_after" TYPE timestamptz(3);
ALTER TABLE "public"."events" ALTER COLUMN "review_flagged_at" TYPE timestamptz(3);
ALTER TABLE "public"."events" ALTER COLUMN "timestamp" TYPE timestamptz(3);

-- public.evidence_decisions
ALTER TABLE "public"."evidence_decisions" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.export_jobs
ALTER TABLE "public"."export_jobs" ALTER COLUMN "completed_at" TYPE timestamptz(3);
ALTER TABLE "public"."export_jobs" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."export_jobs" ALTER COLUMN "expires_at" TYPE timestamptz(3);

-- public.ingestion_review_items
ALTER TABLE "public"."ingestion_review_items" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."ingestion_review_items" ALTER COLUMN "not_before" TYPE timestamptz(3);
ALTER TABLE "public"."ingestion_review_items" ALTER COLUMN "resolved_at" TYPE timestamptz(3);

-- public.invariant_calibrations
ALTER TABLE "public"."invariant_calibrations" ALTER COLUMN "computed_at" TYPE timestamptz(3);

-- public.invariant_outputs
ALTER TABLE "public"."invariant_outputs" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.invariant_promotions
ALTER TABLE "public"."invariant_promotions" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.invariant_run_metadata
ALTER TABLE "public"."invariant_run_metadata" ALTER COLUMN "started_at" TYPE timestamptz(3);

-- public.item_safety_states
ALTER TABLE "public"."item_safety_states" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.job_leases
ALTER TABLE "public"."job_leases" ALTER COLUMN "acquired_at" TYPE timestamptz(3);
ALTER TABLE "public"."job_leases" ALTER COLUMN "locked_until" TYPE timestamptz(3);

-- public.lcap_block_provenance
ALTER TABLE "public"."lcap_block_provenance" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.lcap_block_publish_review
ALTER TABLE "public"."lcap_block_publish_review" ALTER COLUMN "decided_at" TYPE timestamptz(3);

-- public.lcap_fork_evidence
ALTER TABLE "public"."lcap_fork_evidence" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.lcap_publish_audit
ALTER TABLE "public"."lcap_publish_audit" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.lenses
ALTER TABLE "public"."lenses" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."lenses" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.mfa_recovery_codes
ALTER TABLE "public"."mfa_recovery_codes" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."mfa_recovery_codes" ALTER COLUMN "used_at" TYPE timestamptz(3);

-- public.mfci_cases
ALTER TABLE "public"."mfci_cases" ALTER COLUMN "opened_at" TYPE timestamptz(3);
ALTER TABLE "public"."mfci_cases" ALTER COLUMN "resolved_at" TYPE timestamptz(3);

-- public.mfci_margins
ALTER TABLE "public"."mfci_margins" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."mfci_margins" ALTER COLUMN "window_start" TYPE timestamptz(3);

-- public.mfci_risk_states
ALTER TABLE "public"."mfci_risk_states" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.moderation_actions
ALTER TABLE "public"."moderation_actions" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.moderation_appeals
ALTER TABLE "public"."moderation_appeals" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."moderation_appeals" ALTER COLUMN "decided_at" TYPE timestamptz(3);
ALTER TABLE "public"."moderation_appeals" ALTER COLUMN "sla_due_at" TYPE timestamptz(3);

-- public.moderation_audit
ALTER TABLE "public"."moderation_audit" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."moderation_audit" ALTER COLUMN "event_time" TYPE timestamptz(3);

-- public.moderation_cases
ALTER TABLE "public"."moderation_cases" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."moderation_cases" ALTER COLUMN "sla_due_at" TYPE timestamptz(3);
ALTER TABLE "public"."moderation_cases" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.moderation_notices
ALTER TABLE "public"."moderation_notices" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."moderation_notices" ALTER COLUMN "read_at" TYPE timestamptz(3);

-- public.moderation_reports
ALTER TABLE "public"."moderation_reports" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.private_rendezvous_records
ALTER TABLE "public"."private_rendezvous_records" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."private_rendezvous_records" ALTER COLUMN "expires_at" TYPE timestamptz(3);

-- public.private_room_stubs
ALTER TABLE "public"."private_room_stubs" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."private_room_stubs" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.push_preferences
ALTER TABLE "public"."push_preferences" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.push_subscriptions
ALTER TABLE "public"."push_subscriptions" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.pwatt_config
ALTER TABLE "public"."pwatt_config" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.ranking_decision_logs
ALTER TABLE "public"."ranking_decision_logs" ALTER COLUMN "retain_until" TYPE timestamptz(3);
ALTER TABLE "public"."ranking_decision_logs" ALTER COLUMN "timestamp" TYPE timestamptz(3);

-- public.ranking_feature_vectors
ALTER TABLE "public"."ranking_feature_vectors" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.reply_notifications
ALTER TABLE "public"."reply_notifications" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."reply_notifications" ALTER COLUMN "read_at" TYPE timestamptz(3);

-- public.reviewer_status
ALTER TABLE "public"."reviewer_status" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.room_stewards
ALTER TABLE "public"."room_stewards" ALTER COLUMN "assigned_at" TYPE timestamptz(3);

-- public.room_subscriptions
ALTER TABLE "public"."room_subscriptions" ALTER COLUMN "joined_at" TYPE timestamptz(3);
ALTER TABLE "public"."room_subscriptions" ALTER COLUMN "requested_at" TYPE timestamptz(3);

-- public.rooms
ALTER TABLE "public"."rooms" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."rooms" ALTER COLUMN "latest_activity_at" TYPE timestamptz(3);
ALTER TABLE "public"."rooms" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.sessions
ALTER TABLE "public"."sessions" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."sessions" ALTER COLUMN "last_active_at" TYPE timestamptz(3);
ALTER TABLE "public"."sessions" ALTER COLUMN "revoked_at" TYPE timestamptz(3);

-- public.signal_ledger_entries
ALTER TABLE "public"."signal_ledger_entries" ALTER COLUMN "purge_after" TYPE timestamptz(3);
ALTER TABLE "public"."signal_ledger_entries" ALTER COLUMN "recorded_at" TYPE timestamptz(3);
ALTER TABLE "public"."signal_ledger_entries" ALTER COLUMN "window_start" TYPE timestamptz(3);

-- public.source_syndications
ALTER TABLE "public"."source_syndications" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.sources
ALTER TABLE "public"."sources" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."sources" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.stories
ALTER TABLE "public"."stories" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."stories" ALTER COLUMN "last_material_update_at" TYPE timestamptz(3);
ALTER TABLE "public"."stories" ALTER COLUMN "published_at" TYPE timestamptz(3);
ALTER TABLE "public"."stories" ALTER COLUMN "settled_at" TYPE timestamptz(3);
ALTER TABLE "public"."stories" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.story_freshness
ALTER TABLE "public"."story_freshness" ALTER COLUMN "computed_at" TYPE timestamptz(3);

-- public.story_lifecycle_audits
ALTER TABLE "public"."story_lifecycle_audits" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.story_signatures
ALTER TABLE "public"."story_signatures" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.story_source_links
ALTER TABLE "public"."story_source_links" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.takedown_requests
ALTER TABLE "public"."takedown_requests" ALTER COLUMN "actioned_at" TYPE timestamptz(3);
ALTER TABLE "public"."takedown_requests" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.threads
ALTER TABLE "public"."threads" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."threads" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.uploads
ALTER TABLE "public"."uploads" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.user_auth
ALTER TABLE "public"."user_auth" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."user_auth" ALTER COLUMN "email_verified_at" TYPE timestamptz(3);
ALTER TABLE "public"."user_auth" ALTER COLUMN "mfa_enrolled_at" TYPE timestamptz(3);
ALTER TABLE "public"."user_auth" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.user_settings
ALTER TABLE "public"."user_settings" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.users
ALTER TABLE "public"."users" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."users" ALTER COLUMN "updated_at" TYPE timestamptz(3);

-- public.wallet_auth_credentials
ALTER TABLE "public"."wallet_auth_credentials" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."wallet_auth_credentials" ALTER COLUMN "last_used_at" TYPE timestamptz(3);

-- public.web_vital_aggregates
ALTER TABLE "public"."web_vital_aggregates" ALTER COLUMN "window_end" TYPE timestamptz(3);

-- public.web_vital_samples
ALTER TABLE "public"."web_vital_samples" ALTER COLUMN "created_at" TYPE timestamptz(3);

-- public.webauthn_credentials
ALTER TABLE "public"."webauthn_credentials" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "public"."webauthn_credentials" ALTER COLUMN "last_used_at" TYPE timestamptz(3);

-- wallet.wallet_accounts
ALTER TABLE "wallet"."wallet_accounts" ALTER COLUMN "last_used_at" TYPE timestamptz(3);
ALTER TABLE "wallet"."wallet_accounts" ALTER COLUMN "linked_at" TYPE timestamptz(3);
ALTER TABLE "wallet"."wallet_accounts" ALTER COLUMN "unlink_finalize_after" TYPE timestamptz(3);
ALTER TABLE "wallet"."wallet_accounts" ALTER COLUMN "unlink_requested_at" TYPE timestamptz(3);
ALTER TABLE "wallet"."wallet_accounts" ALTER COLUMN "unlinked_at" TYPE timestamptz(3);
