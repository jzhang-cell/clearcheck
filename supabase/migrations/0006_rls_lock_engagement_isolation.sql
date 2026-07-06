-- ═══════════════════════════════════════════════════════════════════
-- ClearCheck V3 — RLS "Lock" step: engagement-isolation policies
-- Migration: 0006_rls_lock_engagement_isolation.sql
--
-- Replaces the per-operation policies on every client-data table with ONE
-- consistent "engagement isolation" policy each. A row is visible/writable
-- only if its engagement matches the caller, where "the caller's engagement"
-- is established by EITHER:
--   (a) machine path  — a session variable `app.current_engagement_id`,
--       set per-request by the function (the "Stamp" step, later), OR
--   (b) human path    — the logged-in user's engagements via engagement_users
--       (user_engagement_ids(); dormant for the pilot, ready post-pilot).
--
-- ── SAFETY ──
-- This changes NO current behavior: every edge function still connects with
-- the service_role key, which BYPASSES RLS. So the live audit pipeline is
-- unaffected. Enforcement only "bites" once the functions stop using
-- service_role for client data (Restrict) and start setting the scoped
-- variable (Stamp). This migration just installs the correct locks.
--
-- System/shared tables (prompts, tscs, job_runs, engagement_users) are left
-- as-is — they legitimately span engagements and stay elevated.
-- ═══════════════════════════════════════════════════════════════════

-- Reusable predicate, inlined per table (engagement_id flavour):
--   engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
--   or engagement_id in (select user_engagement_ids())

-- ── engagements (its own id IS the engagement) ──
drop policy if exists "users see their engagements" on engagements;
create policy "engagements_isolation" on engagements
  for all
  using (
    id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or id in (select user_engagement_ids())
  )
  with check (
    id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or id in (select user_engagement_ids())
  );

-- ── controls ──
drop policy if exists "controls select" on controls;
drop policy if exists "controls insert" on controls;
drop policy if exists "controls update" on controls;
drop policy if exists "controls delete" on controls;
create policy "controls_isolation" on controls
  for all
  using (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  )
  with check (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  );

-- ── sample_tests ──
drop policy if exists "sample_tests select" on sample_tests;
drop policy if exists "sample_tests write" on sample_tests;
create policy "sample_tests_isolation" on sample_tests
  for all
  using (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  )
  with check (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  );

-- ── evidence_files ──
drop policy if exists "evidence_files select" on evidence_files;
drop policy if exists "evidence_files write" on evidence_files;
create policy "evidence_files_isolation" on evidence_files
  for all
  using (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  )
  with check (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  );

-- ── audit_runs ──
drop policy if exists "audit_runs select" on audit_runs;
drop policy if exists "audit_runs write" on audit_runs;
create policy "audit_runs_isolation" on audit_runs
  for all
  using (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  )
  with check (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  );

-- ── extracted_evidence (engagement_id added in 0005) ──
drop policy if exists "extracted_evidence select" on extracted_evidence;
drop policy if exists "extracted_evidence write" on extracted_evidence;
create policy "extracted_evidence_isolation" on extracted_evidence
  for all
  using (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  )
  with check (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  );

-- ── audit_results (engagement_id added in 0005) ──
drop policy if exists "audit_results select" on audit_results;
drop policy if exists "audit_results write" on audit_results;
create policy "audit_results_isolation" on audit_results
  for all
  using (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  )
  with check (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  );

-- ── evidence_control_links (engagement_id added in 0005) ──
drop policy if exists "evidence_control_links select" on evidence_control_links;
drop policy if exists "evidence_control_links write" on evidence_control_links;
create policy "evidence_control_links_isolation" on evidence_control_links
  for all
  using (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  )
  with check (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  );

-- ── control_tscs (engagement_id added in 0005) ──
drop policy if exists "control_tscs select" on control_tscs;
drop policy if exists "control_tscs write" on control_tscs;
create policy "control_tscs_isolation" on control_tscs
  for all
  using (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  )
  with check (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  );
