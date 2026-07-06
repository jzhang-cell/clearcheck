-- ═══════════════════════════════════════════════════════════════════
-- ClearCheck V3 — job_runs schema additions for async batch
-- Migration: 0002_job_runs_async_batch.sql
--
-- Adds parent/child linkage and progress snapshot to job_runs so that
-- ingest-evidence-batch can act as a coordinator: it inserts a parent row,
-- spawns child per-file ingest jobs, and tracks aggregate progress on the
-- parent's `progress` JSONB. Caller polls /job-status with the parent id.
--
-- ON DELETE SET NULL (rather than CASCADE) so deleting a parent batch row
-- leaves the per-file children intact — they're still useful audit trail.
-- ═══════════════════════════════════════════════════════════════════

alter table job_runs
  add column parent_job_id uuid references job_runs(id) on delete set null,
  add column progress jsonb;

-- Speeds up "list all children of this parent batch" lookups. Partial index
-- since the vast majority of job_runs have no parent (single-file ingests,
-- refines, audits, etc.).
create index job_runs_parent_job_id_idx
  on job_runs(parent_job_id)
  where parent_job_id is not null;
