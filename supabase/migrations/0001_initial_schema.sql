-- ═══════════════════════════════════════════════════════════════════
-- ClearCheck V3 — Initial Schema
-- Migration: 0001_initial_schema.sql
-- ═══════════════════════════════════════════════════════════════════

-- Extensions
create extension if not exists vector;
create extension if not exists pgcrypto;

-- ═══════════════════════════════════════════════════════════════════
-- LAYER 1: Reference data (engagement-agnostic)
-- ═══════════════════════════════════════════════════════════════════

create table tscs (
  id uuid primary key default gen_random_uuid(),
  tsc_code text unique not null,
  trust_principle text not null,
  common_criteria_category text,
  description text not null,
  points_of_focus text,
  additional_points_of_focus text,
  created_at timestamptz default now()
);

create table prompts (
  id uuid primary key default gen_random_uuid(),
  prompt_key text not null,
  version text not null,
  model text not null,
  system_prompt text,
  user_prompt_template text not null,
  max_tokens integer default 4096,
  is_active boolean default true,
  notes text,
  created_at timestamptz default now(),
  unique(prompt_key, version)
);

create unique index one_active_prompt_per_key
  on prompts(prompt_key) where is_active = true;

-- ═══════════════════════════════════════════════════════════════════
-- LAYER 2: Engagement scoping (multi-tenant root)
-- ═══════════════════════════════════════════════════════════════════

create table engagements (
  id uuid primary key default gen_random_uuid(),
  client_name text not null,
  audit_type text not null,
  attest_start date not null,
  attest_end date not null,
  status text default 'active',
  airtable_base_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table engagement_users (
  engagement_id uuid not null references engagements(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text default 'auditor',
  added_at timestamptz default now(),
  primary key (engagement_id, user_id)
);

create index on engagement_users(user_id);

-- Helper for RLS policies
create or replace function user_engagement_ids()
returns setof uuid
language sql
security definer
stable
as $$
  select engagement_id from engagement_users where user_id = auth.uid()
$$;

-- ═══════════════════════════════════════════════════════════════════
-- LAYER 3: Engagement-scoped domain tables
-- ═══════════════════════════════════════════════════════════════════

create table controls (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  control_id text not null,
  company_control text,
  control_description text,
  expected_procedures text,
  refined_control_description text,
  refined_expected_procedure text,
  refinement_status text default 'pending',
  refined_at timestamptz,
  status text default 'pending',
  latest_audit_run_id uuid,
  airtable_record_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(engagement_id, control_id)
);

create index on controls(engagement_id);
create index on controls(status);

create table control_tscs (
  control_id uuid not null references controls(id) on delete cascade,
  tsc_id uuid not null references tscs(id) on delete restrict,
  primary key (control_id, tsc_id)
);

create table sample_tests (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  control_id uuid not null references controls(id) on delete cascade,
  name text not null,
  description text,
  status text default 'pending',
  expected_population integer,
  actual_population integer,
  sample_size integer,
  testing_table_url text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index on sample_tests(control_id);

-- ═══════════════════════════════════════════════════════════════════
-- LAYER 4: Evidence pipeline
-- ═══════════════════════════════════════════════════════════════════

create table evidence_files (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  control_id uuid references controls(id) on delete set null,
  file_hash text not null,
  filename text not null,
  file_type text not null,
  file_size_bytes bigint,
  mime_type text,
  storage_path text not null,
  source text default 'direct_upload',
  source_metadata jsonb,
  uploaded_at timestamptz default now(),
  status text default 'pending',
  error_message text,
  unique(engagement_id, file_hash)
);

create index on evidence_files(control_id);
create index on evidence_files(status);
create index on evidence_files(file_hash);

create table evidence_control_links (
  evidence_file_id uuid not null references evidence_files(id) on delete cascade,
  control_id uuid not null references controls(id) on delete cascade,
  primary key (evidence_file_id, control_id)
);

create table extracted_evidence (
  id uuid primary key default gen_random_uuid(),
  evidence_file_id uuid not null references evidence_files(id) on delete cascade,
  extractor_prompt_id uuid not null references prompts(id),
  extracted_content jsonb not null,
  raw_extracted_text text,
  scratchpad text,
  embedding vector(1536),
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric(10,4),
  extracted_at timestamptz default now()
);

comment on column extracted_evidence.embedding is
  'Embedding from OpenAI text-embedding-3-small (1536 dimensions)';

create index on extracted_evidence(evidence_file_id);
create index on extracted_evidence using ivfflat (embedding vector_cosine_ops);

-- ═══════════════════════════════════════════════════════════════════
-- LAYER 5: Audit execution
-- ═══════════════════════════════════════════════════════════════════

create table audit_runs (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  control_id uuid not null references controls(id) on delete cascade,
  evidence_file_ids uuid[] not null,
  evidence_synthesis text,
  audit_prompt_id uuid references prompts(id),
  status text default 'pending',
  triggered_by text,
  started_at timestamptz default now(),
  completed_at timestamptz,
  duration_ms integer,
  error_message text
);

create index on audit_runs(control_id);
create index on audit_runs(engagement_id, started_at desc);

create table audit_results (
  id uuid primary key default gen_random_uuid(),
  audit_run_id uuid not null references audit_runs(id) on delete cascade,
  conformity_status text not null,
  conformity_level text,
  conformity_determination text,
  conformity_briefing text,
  deviations jsonb,
  potential_clarifications text,
  root_cause_category text,
  root_cause_analysis text,
  rendered_markdown text,
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric(10,4),
  generated_at timestamptz default now()
);

create index on audit_results(audit_run_id);

-- Now we can add the FK from controls.latest_audit_run_id (chicken-and-egg deferred)
alter table controls
  add constraint controls_latest_audit_run_fk
  foreign key (latest_audit_run_id) references audit_runs(id) on delete set null;

-- ═══════════════════════════════════════════════════════════════════
-- LAYER 6: Operations (monitoring fix)
-- ═══════════════════════════════════════════════════════════════════

create table job_runs (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid references engagements(id) on delete set null,
  function_name text not null,
  trigger_source text,
  payload jsonb,
  result jsonb,
  status text not null default 'running',
  error_message text,
  error_stack text,
  retry_count integer default 0,
  started_at timestamptz default now(),
  completed_at timestamptz,
  duration_ms integer
);

create index on job_runs(function_name, started_at desc);
create index on job_runs(engagement_id, started_at desc) where engagement_id is not null;
create index on job_runs(status) where status = 'failed';

-- ═══════════════════════════════════════════════════════════════════
-- LAYER 7: Storage
-- ═══════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public)
values ('evidence', 'evidence', false)
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════
-- LAYER 8: Row-Level Security
-- ═══════════════════════════════════════════════════════════════════

alter table engagements enable row level security;
alter table engagement_users enable row level security;
alter table controls enable row level security;
alter table control_tscs enable row level security;
alter table sample_tests enable row level security;
alter table evidence_files enable row level security;
alter table evidence_control_links enable row level security;
alter table extracted_evidence enable row level security;
alter table audit_runs enable row level security;
alter table audit_results enable row level security;
alter table job_runs enable row level security;
alter table tscs enable row level security;
alter table prompts enable row level security;

-- engagements: users see their assigned engagements
create policy "users see their engagements" on engagements
  for select using (id in (select user_engagement_ids()));

-- engagement_users: users see their own assignments
create policy "users see their own assignments" on engagement_users
  for select using (user_id = auth.uid());

-- controls: full CRUD scoped to engagement
create policy "controls select" on controls
  for select using (engagement_id in (select user_engagement_ids()));
create policy "controls insert" on controls
  for insert with check (engagement_id in (select user_engagement_ids()));
create policy "controls update" on controls
  for update using (engagement_id in (select user_engagement_ids()));
create policy "controls delete" on controls
  for delete using (engagement_id in (select user_engagement_ids()));

-- control_tscs: scoped via parent control
create policy "control_tscs select" on control_tscs
  for select using (control_id in (
    select id from controls where engagement_id in (select user_engagement_ids())
  ));
create policy "control_tscs write" on control_tscs
  for all using (control_id in (
    select id from controls where engagement_id in (select user_engagement_ids())
  ));

-- sample_tests
create policy "sample_tests select" on sample_tests
  for select using (engagement_id in (select user_engagement_ids()));
create policy "sample_tests write" on sample_tests
  for all using (engagement_id in (select user_engagement_ids()));

-- evidence_files
create policy "evidence_files select" on evidence_files
  for select using (engagement_id in (select user_engagement_ids()));
create policy "evidence_files write" on evidence_files
  for all using (engagement_id in (select user_engagement_ids()));

-- evidence_control_links: scoped via parent
create policy "evidence_control_links select" on evidence_control_links
  for select using (control_id in (
    select id from controls where engagement_id in (select user_engagement_ids())
  ));
create policy "evidence_control_links write" on evidence_control_links
  for all using (control_id in (
    select id from controls where engagement_id in (select user_engagement_ids())
  ));

-- extracted_evidence: scoped via parent evidence_file
create policy "extracted_evidence select" on extracted_evidence
  for select using (evidence_file_id in (
    select id from evidence_files where engagement_id in (select user_engagement_ids())
  ));
create policy "extracted_evidence write" on extracted_evidence
  for all using (evidence_file_id in (
    select id from evidence_files where engagement_id in (select user_engagement_ids())
  ));

-- audit_runs
create policy "audit_runs select" on audit_runs
  for select using (engagement_id in (select user_engagement_ids()));
create policy "audit_runs write" on audit_runs
  for all using (engagement_id in (select user_engagement_ids()));

-- audit_results: scoped via parent run
create policy "audit_results select" on audit_results
  for select using (audit_run_id in (
    select id from audit_runs where engagement_id in (select user_engagement_ids())
  ));
create policy "audit_results write" on audit_results
  for all using (audit_run_id in (
    select id from audit_runs where engagement_id in (select user_engagement_ids())
  ));

-- job_runs: users see logs for their engagements (and global ones if engagement_id is null and they're admin — TODO Phase 2)
create policy "job_runs select" on job_runs
  for select using (
    engagement_id in (select user_engagement_ids())
    or engagement_id is null
  );

-- Reference data: any authenticated user can read
create policy "tscs read" on tscs
  for select using (auth.role() = 'authenticated');

create policy "prompts read" on prompts
  for select using (auth.role() = 'authenticated');

-- Note: edge functions use service_role key which bypasses all RLS.
-- This is the correct pattern for system-level operations.

-- ═══════════════════════════════════════════════════════════════════
-- updated_at triggers
-- ═══════════════════════════════════════════════════════════════════

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger engagements_updated_at before update on engagements
  for each row execute function set_updated_at();
create trigger controls_updated_at before update on controls
  for each row execute function set_updated_at();
create trigger sample_tests_updated_at before update on sample_tests
  for each row execute function set_updated_at();
