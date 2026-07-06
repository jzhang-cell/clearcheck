-- ═══════════════════════════════════════════════════════════════════
-- ClearCheck V3 — Remediation re-run support
-- Migration: 0010_audit_runs_rerun.sql
-- ═══════════════════════════════════════════════════════════════════
--
-- The "Re-run Audit 🤖" re-run flow re-judges a control AFTER the auditor
-- submits NEW evidence and/or NEW notes (rerun-audit + audit_remediation
-- prompt). A re-run records a fresh audit_runs row, exactly like an initial
-- audit, but we tag it so history is legible and the previous verdict it
-- supersedes is traceable.
--
-- New columns on audit_runs (all nullable / defaulted — existing rows are
-- unaffected and read as 'initial'):
--   run_type              'initial' | 'remediation'
--   auditor_notes         the free-text [Additional Notes] used for this run
--   previous_audit_run_id the audit_run whose verdict this re-assessment supersedes

alter table audit_runs
  add column if not exists run_type text not null default 'initial',
  add column if not exists auditor_notes text,
  add column if not exists previous_audit_run_id uuid
    references audit_runs(id) on delete set null;

comment on column audit_runs.run_type is
  'initial | remediation — remediation runs re-judge a prior verdict over new evidence/notes';
comment on column audit_runs.auditor_notes is
  'Free-text auditor context supplied at re-run time (Airtable [Additional Notes] field)';
comment on column audit_runs.previous_audit_run_id is
  'For remediation runs: the audit_run whose verdict this re-assessment supersedes';

create index if not exists audit_runs_previous_run_idx
  on audit_runs(previous_audit_run_id)
  where previous_audit_run_id is not null;
