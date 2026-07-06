-- ═══════════════════════════════════════════════════════════════════
-- ClearCheck V3 — drop unused audit_results.conformity_level
-- Migration: 0004_drop_audit_results_conformity_level.sql
--
-- conformity_level is no longer persisted. It is still emitted by the
-- audit_judge prompt and used INTERNALLY by _shared/claude-parse.ts to
-- derive conformity_status (and is still written to Airtable as
-- V3_Conformity_Level) — we simply stop storing it in audit_results.
-- run-audit was redeployed to drop it from the insert before this runs.
-- ═══════════════════════════════════════════════════════════════════

alter table audit_results drop column if exists conformity_level;
