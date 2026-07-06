-- ═══════════════════════════════════════════════════════════════════
-- ClearCheck V3 — RLS "Restrict" foundation: the engagement-scoped role
-- Migration: 0007_engagement_scoped_role.sql
--
-- Creates the non-superuser, NON-bypass role the edge functions will use for
-- CLIENT-DATA reads/writes (the "badge" they wear instead of the service_role
-- master key). It is subject to RLS, so the engagement-isolation policies from
-- 0006 actually apply to it. The function sets `app.current_engagement_id` for
-- the request (Stamp) and connects/SET ROLEs as this role (Restrict).
--
-- Grants cover ONLY client-data tables + the universal `tscs` reference list
-- (needed for the control↔TSC join). It is deliberately NOT granted on the
-- system tables (prompts, job_runs) — those stay service_role only.
--
-- SAFE: creating + granting a role changes no current behavior. Nothing uses
-- this role until run-audit (and then the other functions) are rewired.
-- ═══════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'engagement_scoped') then
    create role engagement_scoped nologin;
  end if;
end
$$;

grant usage on schema public to engagement_scoped;

-- Client-data tables: full CRUD, but every row gated by the 0006 RLS policies.
grant select, insert, update, delete on
  engagements,
  controls,
  sample_tests,
  evidence_files,
  audit_runs,
  extracted_evidence,
  audit_results,
  evidence_control_links,
  control_tscs
to engagement_scoped;

-- Universal reference data the scoped queries join against (read-only).
grant select on tscs to engagement_scoped;

-- tscs has an RLS read policy tied to the 'authenticated' role; add a targeted
-- read policy so the scoped role can read the universal TSC list (not client data).
drop policy if exists "tscs read by scoped role" on tscs;
create policy "tscs read by scoped role" on tscs
  for select to engagement_scoped using (true);

-- The isolation policies call this helper; the scoped role must be able to run it.
grant execute on function user_engagement_ids() to engagement_scoped;

-- So the function's DB connection (role `postgres`) can SET ROLE to it.
grant engagement_scoped to postgres;
