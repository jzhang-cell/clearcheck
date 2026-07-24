-- ════════════════════════════════════════════════════════════════════
-- ClearCheck V3 — durable Make.com extraction for large PDFs
-- Migration: 0017_make_large_pdf_extraction.sql
-- ════════════════════════════════════════════════════════════════════
--
-- A large PDF can outlive a Supabase Edge Function isolate. These two system
-- tables let ingest-evidence hand only the expensive PDF extraction to Make,
-- return immediately, and resume sync-control-evidence after Make calls back.
--
-- Both tables contain orchestration state, not client-facing application data.
-- RLS is enabled with no policies, so only service_role can access them.

create table evidence_sync_runs (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  control_uuid uuid not null references controls(id) on delete cascade,
  status text not null default 'dispatching'
    check (status in ('dispatching', 'waiting_external', 'resuming', 'completed', 'failed')),
  total_files integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Prevent two Airtable clicks from starting two Make scenarios for the same
-- control. Completed/failed history never blocks a fresh run.
create unique index evidence_sync_runs_one_live_per_control
  on evidence_sync_runs(control_uuid)
  where status in ('dispatching', 'waiting_external', 'resuming');

create index evidence_sync_runs_status
  on evidence_sync_runs(status, updated_at);

create table external_extraction_jobs (
  id uuid primary key default gen_random_uuid(),
  sync_run_id uuid not null references evidence_sync_runs(id) on delete cascade,
  engagement_id uuid not null references engagements(id) on delete cascade,
  control_uuid uuid not null references controls(id) on delete cascade,
  evidence_file_id uuid not null references evidence_files(id) on delete cascade,
  extractor_prompt_id uuid not null references prompts(id) on delete restrict,
  provider text not null default 'make',
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completing', 'completed', 'failed')),
  filename text not null,
  storage_path text not null,
  provider_execution_id text,
  attempts integer not null default 0,
  input_tokens integer,
  output_tokens integer,
  error_message text,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ingest-evidence is retry-safe inside one sync cycle. The callback also uses
-- this key to find an already-completed extraction after a transient retry.
create unique index external_extraction_jobs_one_file_per_run
  on external_extraction_jobs(sync_run_id, evidence_file_id, extractor_prompt_id);

create index external_extraction_jobs_pending
  on external_extraction_jobs(sync_run_id, status)
  where status in ('queued', 'processing', 'completing', 'failed');

alter table evidence_sync_runs enable row level security;
alter table external_extraction_jobs enable row level security;

grant select, insert, update, delete on evidence_sync_runs to service_role;
grant select, insert, update, delete on external_extraction_jobs to service_role;
