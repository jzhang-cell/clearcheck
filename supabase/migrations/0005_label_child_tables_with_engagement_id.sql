-- ═══════════════════════════════════════════════════════════════════
-- ClearCheck V3 — RLS "Label" step: engagement_id on every client-data row
-- Migration: 0005_label_child_tables_with_engagement_id.sql
--
-- The top-level client tables (controls, evidence_files, audit_runs,
-- sample_tests) already carry engagement_id. This labels the 4 CHILD tables
-- that inherited it only through a parent FK:
--   extracted_evidence     ← evidence_files
--   audit_results          ← audit_runs
--   evidence_control_links ← controls
--   control_tscs           ← controls
--
-- The label is made SELF-MAINTAINING: a BEFORE INSERT trigger auto-derives
-- engagement_id from the parent when it isn't supplied. So existing inserts
-- (functions + onboarding SQL) keep working unchanged, and the label can
-- never be forgotten or set inconsistently.
--
-- This is ONLY the Label step. It changes no behavior and enforces NO access
-- yet — RLS enforcement (policies biting) + the engagement-scoped identity
-- are separate later steps. Safe / non-breaking.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Add the label column (nullable for now; FK + on delete cascade).
alter table extracted_evidence     add column if not exists engagement_id uuid references engagements(id) on delete cascade;
alter table audit_results          add column if not exists engagement_id uuid references engagements(id) on delete cascade;
alter table evidence_control_links add column if not exists engagement_id uuid references engagements(id) on delete cascade;
alter table control_tscs           add column if not exists engagement_id uuid references engagements(id) on delete cascade;

-- 2. Backfill existing rows from their parent (parents are all NOT NULL).
update extracted_evidence ee
  set engagement_id = ef.engagement_id
  from evidence_files ef
  where ee.evidence_file_id = ef.id and ee.engagement_id is null;

update audit_results ar
  set engagement_id = r.engagement_id
  from audit_runs r
  where ar.audit_run_id = r.id and ar.engagement_id is null;

update evidence_control_links el
  set engagement_id = c.engagement_id
  from controls c
  where el.control_id = c.id and el.engagement_id is null;

update control_tscs ct
  set engagement_id = c.engagement_id
  from controls c
  where ct.control_id = c.id and ct.engagement_id is null;

-- 3. Trigger functions: derive engagement_id from the parent when not provided.
create or replace function set_engagement_id_from_evidence_file()
returns trigger language plpgsql as $$
begin
  if new.engagement_id is null then
    select engagement_id into new.engagement_id
      from evidence_files where id = new.evidence_file_id;
  end if;
  return new;
end;
$$;

create or replace function set_engagement_id_from_audit_run()
returns trigger language plpgsql as $$
begin
  if new.engagement_id is null then
    select engagement_id into new.engagement_id
      from audit_runs where id = new.audit_run_id;
  end if;
  return new;
end;
$$;

create or replace function set_engagement_id_from_control()
returns trigger language plpgsql as $$
begin
  if new.engagement_id is null then
    select engagement_id into new.engagement_id
      from controls where id = new.control_id;
  end if;
  return new;
end;
$$;

-- 4. Attach the triggers (BEFORE INSERT, per row).
create trigger trg_extracted_evidence_engagement
  before insert on extracted_evidence
  for each row execute function set_engagement_id_from_evidence_file();

create trigger trg_audit_results_engagement
  before insert on audit_results
  for each row execute function set_engagement_id_from_audit_run();

create trigger trg_evidence_control_links_engagement
  before insert on evidence_control_links
  for each row execute function set_engagement_id_from_control();

create trigger trg_control_tscs_engagement
  before insert on control_tscs
  for each row execute function set_engagement_id_from_control();

-- 5. Enforce the label (safe now: existing rows backfilled, new rows trigger-filled).
alter table extracted_evidence     alter column engagement_id set not null;
alter table audit_results          alter column engagement_id set not null;
alter table evidence_control_links alter column engagement_id set not null;
alter table control_tscs           alter column engagement_id set not null;

-- 6. Index the label (RLS policies will filter on it).
create index if not exists idx_extracted_evidence_engagement     on extracted_evidence(engagement_id);
create index if not exists idx_audit_results_engagement          on audit_results(engagement_id);
create index if not exists idx_evidence_control_links_engagement on evidence_control_links(engagement_id);
create index if not exists idx_control_tscs_engagement           on control_tscs(engagement_id);
