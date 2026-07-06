-- ════════════════════════════════════════════════════════════════════
-- Migration: 0013_cron_sweep_stuck_jobs.sql
-- ════════════════════════════════════════════════════════════════════
--
-- Schedules the stuck-job WATCHMAN (sweep-stuck-jobs edge function) to run on a
-- fixed cadence via pg_cron + pg_net (NEXT_STEPS §6, Batch Test 01/02 follow-up).
--
-- WHY: a hard edge wall-clock kill leaves a job_runs row orphaned in 'running'
-- forever — the killed worker can't self-report. Something outside it must notice
-- and surface the stall. This cron job pokes the watchman every 5 minutes; the
-- watchman marks orphaned rows 'failed' and writes a recovery message to the
-- control's "ClearCheck 💬" so the auditor knows to press Re-run.
--
-- ── PREREQUISITES (apply on the project BEFORE this migration) ──────────────
--   1. Extensions: pg_cron + pg_net enabled
--        create extension if not exists pg_cron;
--        create extension if not exists pg_net;
--      (On Supabase: Dashboard → Database → Extensions, or the lines above.)
--   2. Two Vault secrets so the cron job can reach + authenticate the function
--      WITHOUT hardcoding them in this file (keeps secrets out of git):
--        - 'project_url'        e.g. https://kwuymtlpjkziqkumixvk.supabase.co
--        - 'audit_shared_secret' = the same AUDIT_SHARED_SECRET the function checks
--      Set them once (psql / SQL editor):
--        select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--        select vault.create_secret('<the-secret>', 'audit_shared_secret');
--
-- This migration is idempotent: it unschedules any prior 'sweep-stuck-jobs' job
-- before (re)creating it, so re-applying is safe.
-- ════════════════════════════════════════════════════════════════════

-- Remove a previously-scheduled instance (no-op on first apply).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sweep-stuck-jobs') then
    perform cron.unschedule('sweep-stuck-jobs');
  end if;
exception
  when undefined_table then
    raise notice 'pg_cron not installed — skipping unschedule. Enable pg_cron then re-apply.';
end $$;

-- Schedule: every 5 minutes, POST the watchman with the shared secret in the
-- x-audit-secret header. URL + secret are read from Vault at call time (not baked
-- into this file). net.http_post is fire-and-forget; the function logs to job_runs.
select cron.schedule(
  'sweep-stuck-jobs',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
             || '/functions/v1/sweep-stuck-jobs',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-audit-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'audit_shared_secret')
      ),
      body := '{}'::jsonb
    );
  $cron$
);

-- Verify after apply:
--   select jobname, schedule, active from cron.job where jobname = 'sweep-stuck-jobs';
--   -- then watch it work:
--   select function_name, status, result, started_at
--     from job_runs where function_name = 'sweep-stuck-jobs'
--     order by started_at desc limit 5;
