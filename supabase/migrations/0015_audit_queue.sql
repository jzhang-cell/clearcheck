-- ════════════════════════════════════════════════════════════════════
-- Migration: 0015_audit_queue.sql
-- ════════════════════════════════════════════════════════════════════
--
-- The DURABLE QUEUE for the sync → run-audit handoff (ADR-015, Batch Test 04
-- challenge #3). Until now sync-control-evidence handed off to run-audit with a
-- single fire-and-forget POST: if that one packet was lost (5xx, cold start,
-- isolate killed between completeJobRun and the trigger), the control sat at
-- "Evidence ready" forever with no error anywhere — invisible to the watchman
-- because the sync job SUCCEEDED, so there was no stuck row to sweep.
--
-- This queue flips the handoff from "phone the next step" to "write the work
-- down, then nudge". sync INSERTs a row here; the audit-worker function claims
-- rows in small leased batches and runs the audit pipeline. A lost nudge or a
-- killed worker no longer loses the work: the row is still here, the lease
-- expires, and the next claim retries it. Durability lives in this table, not
-- in any network call.
--
-- Design notes:
--   - Plain public-schema table + one claim function (FOR UPDATE SKIP LOCKED)
--     instead of pgmq: the enqueue rides the same PostgREST service client as
--     job_runs (no new grants/plumbing), the rows are visible in Studio, and
--     the retry/dead-letter logic stays explicit and unit-testable.
--   - `attempts` counts CLAIMS, not explicit failures — a worker killed by the
--     platform never reports back, so the claim is the only moment we can be
--     sure to count. Dead-letter decisions key off it (see audit-worker).
--   - status: pending | processing | done | dead. 'dead' rows are surfaced to
--     the auditor via 💬 by the worker; 'done' rows are kept as cheap history.
--
-- ── PREREQUISITES (same as 0013 — verify they are actually applied!) ────────
--   1. Extensions pg_cron + pg_net enabled on the project.
--   2. Vault secrets 'project_url' + 'audit_shared_secret' set (0013's cron
--      reads the same two). Batch Test 04 root cause: 0013's schedule was never
--      set up in prod — do not repeat that with this one. Verify after apply:
--        select jobname, schedule, active from cron.job
--        where jobname in ('sweep-stuck-jobs', 'audit-worker-poke');
-- ════════════════════════════════════════════════════════════════════

create table audit_queue (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  control_uuid uuid not null references controls(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'dead')),
  attempts integer not null default 0,
  -- Backoff gate: a pending row is claimable only once visible_at has passed.
  visible_at timestamptz not null default now(),
  -- Lease: while processing, the row is invisible until this expires; a worker
  -- that dies mid-audit simply lets it lapse and the row is reclaimed.
  lease_expires_at timestamptz,
  enqueued_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text
);

-- One LIVE row per control: a double-enqueue (double-tick, re-run racing a
-- sync, redundant kick) collapses into the existing row via ON CONFLICT in the
-- enqueue helper. done/dead rows don't block a later re-enqueue.
create unique index audit_queue_one_live_per_control
  on audit_queue(control_uuid) where status in ('pending', 'processing');

-- Claim scan: pending rows ordered by age, gated on visible_at.
create index audit_queue_claimable
  on audit_queue(visible_at) where status = 'pending';

-- Lease-reclaim scan inside claim_audit_jobs.
create index audit_queue_leases
  on audit_queue(lease_expires_at) where status = 'processing';

-- System table: RLS on with NO policies — only service_role (which bypasses
-- RLS) can touch it, same posture as job_runs. The engagement_scoped role and
-- any future user JWTs see nothing.
alter table audit_queue enable row level security;

-- Explicit grant — this project had "expose new tables" disabled at creation
-- (see STATUS.md gotcha), so don't rely on default privileges existing.
grant select, insert, update, delete on audit_queue to service_role;

-- ── claim_audit_jobs ────────────────────────────────────────────────────────
-- The one piece of queue mechanics that must live in SQL: claim up to p_batch
-- rows atomically so N concurrent workers never grab the same row. Two steps:
--   1. Reclaim: processing rows whose lease lapsed go back to pending (their
--      worker is dead). attempts is NOT bumped here — it was bumped at claim.
--   2. Claim: lock claimable pending rows with FOR UPDATE SKIP LOCKED, flip
--      them to processing, bump attempts, stamp the new lease, return them.
-- SECURITY DEFINER so the service client can call it via PostgREST rpc()
-- without table-level SQL; search_path pinned per definer-function hygiene.
create or replace function claim_audit_jobs(
  p_batch integer default 3,
  p_lease_seconds integer default 600
)
returns setof audit_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  update audit_queue
  set status = 'pending', visible_at = now(), lease_expires_at = null
  where status = 'processing' and lease_expires_at < now();

  return query
  update audit_queue q
  set status = 'processing',
      attempts = q.attempts + 1,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where q.id in (
    select c.id from audit_queue c
    where c.status = 'pending' and c.visible_at <= now()
    order by c.enqueued_at
    for update skip locked
    limit greatest(1, p_batch)
  )
  returning q.*;
end
$$;

-- Definer functions default to EXECUTE for public — lock that down.
revoke execute on function claim_audit_jobs(integer, integer) from public;
grant execute on function claim_audit_jobs(integer, integer) to service_role;

-- ── Cron heartbeat ──────────────────────────────────────────────────────────
-- Poke audit-worker every minute. The enqueue path also "kicks" the worker
-- directly for low latency, but THIS is the delivery guarantee: a lost kick now
-- means ≤60s extra latency, not a stalled control. Same idempotent
-- unschedule-then-schedule pattern and Vault-secret plumbing as 0013.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'audit-worker-poke') then
    perform cron.unschedule('audit-worker-poke');
  end if;
exception
  when undefined_table then
    raise notice 'pg_cron not installed — skipping unschedule. Enable pg_cron then re-apply.';
end $$;

select cron.schedule(
  'audit-worker-poke',
  '* * * * *',
  $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
             || '/functions/v1/audit-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-audit-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'audit_shared_secret')
      ),
      body := '{"trigger_source":"cron"}'::jsonb
    );
  $cron$
);

-- Verify after apply:
--   select jobname, schedule, active from cron.job where jobname = 'audit-worker-poke';
--   -- then watch the worker claim + drain:
--   select status, count(*) from audit_queue group by status;
--   select function_name, status, result, started_at from job_runs
--     where function_name = 'audit-worker' order by started_at desc limit 5;
