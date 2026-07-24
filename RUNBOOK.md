# ClearCheck — Operations Runbook

Use this guide for routine operation and first-response troubleshooting. For
deployment and architecture details, see
[docs/TECHNICAL_HANDOVER.md](docs/TECHNICAL_HANDOVER.md).

## Operating rules

1. Supabase is the workflow source of truth; Airtable is the user interface.
2. A `202` or “started” message means work was accepted, not completed.
3. Do not start a duplicate run until you confirm the existing sync is stale or
   failed.
4. Never place secrets in Git, tickets, chat, or command history.
5. Do not deploy from the client repository until the synchronized handover PR
   is reviewed, merged, and tagged.

## Routine workflows

### Onboard an engagement

1. Duplicate and configure the approved Airtable template.
2. Confirm the Airtable base ID and engagement record.
3. Confirm the Google Drive evidence root and delegated subject.
4. Run the Airtable registration automation.
5. Save the returned engagement UUID and per-engagement key in the configured
   Airtable fields.
6. Verify the engagement row in Supabase.
7. Run one test control before launching the engagement.

Avoid manual database inserts unless performing a documented repair.

### Run one control

1. Confirm the control description, expected procedures, and TSC links.
2. Confirm the evidence source:
   - a non-empty `V3_Evidence` field takes priority; or
   - with `V3_Evidence` empty, the Google Drive control folder is used.
3. Select **Run V3 Audit**.
4. Monitor `ClearCheck 💬`.
5. Treat the run as complete only after `🥳 Audit complete` and the result fields
   are populated.
6. Have an auditor review the evidence and workpaper.

### Run a whole engagement

1. Clear stale `Run V3 Audit` checkboxes from a prior batch.
2. Confirm no older engagement batch is still active.
3. Trigger the Audit Overview run.
4. Ensure the automation calls `pace-controls`.
5. Monitor launched versus remaining controls and active sync jobs.
6. Use the selected-control sweep only for confirmed failed/stale controls.

### Re-run a control

| Choice | Use when | Behavior |
|---|---|---|
| **Run** | The initial sync/audit failed or the full evidence set changed | Fresh evidence sync and audit |
| **Run with Additional Evidence** | New files address the prior conclusion | Remediation using prior result plus new attachments |
| **Run with Additional Notes** | Context addresses the prior conclusion | Remediation using prior result plus notes |

Do not use an Additional Evidence remediation when you intend to replace the
entire initial evidence set.

## Evidence handling

- `V3_Evidence` overrides Drive when it contains attachments.
- Ordinary files are extracted within Supabase.
- PDFs over 50 pages use Make.com when configured.
- ZIP archives must be unpacked before processing.
- Supabase Storage and the evidence tables remain the system of record after
  source files are collected.
- Duplicate filenames are not a reliable identity. Use stored hashes and source
  identifiers when debugging deduplication.

## First-response checklist

When a control appears stuck:

1. Record the engagement, control code, Supabase control UUID, and approximate
   start time.
2. Read the latest `job_runs` for that control.
3. Inspect the exact `evidence_sync_runs` row.
4. If the sync is waiting externally, inspect
   `external_extraction_jobs.provider_execution_url`.
5. Check `audit_queue`, then `audit_runs`.
6. Check `job_runs.result.airtable_sync`.
7. Compare the final database state with Airtable.

Do not infer the cause from a frozen progress message alone.

## Diagnostic queries

### Recent control jobs

```sql
select function_name, status, payload, result, error_message,
       started_at, completed_at
from job_runs
where engagement_id = '<engagement uuid>'
order by started_at desc
limit 100;
```

### Evidence sync

```sql
select id, control_uuid, status, total_files, error_message,
       created_at, updated_at, completed_at
from evidence_sync_runs
where control_uuid = '<control uuid>'
order by created_at desc
limit 10;
```

### External large-PDF jobs

```sql
select id, sync_run_id, filename, status, attempts,
       provider_execution_id, provider_execution_url,
       error_message, queued_at, updated_at, completed_at
from external_extraction_jobs
where control_uuid = '<control uuid>'
order by queued_at desc;
```

### Audit handoff

```sql
select id, control_uuid, status, attempts, visible_at,
       lease_expires_at, last_error, enqueued_at, completed_at
from audit_queue
where control_uuid = '<control uuid>'
order by enqueued_at desc;
```

### Final audit

```sql
select id, status, run_type, previous_audit_run_id,
       error_message, started_at, completed_at
from audit_runs
where control_id = '<control uuid>'
order by started_at desc;
```

## Recovery decisions

| State | Meaning | Action |
|---|---|---|
| Sync is recent and progressing | Live work | Wait |
| External Make job is recent | Large PDF is still processing | Open execution URL; wait unless failed |
| Job is terminal `failed` | Work stopped and reported the cause | Correct the cause, then run again |
| `job_runs` is old and still `running` | Likely orphan | Let cron sweep it or use selected-control recovery |
| Sync completed, queue pending | Audit is waiting for a worker | Check `audit-worker`; do not repeat sync |
| Audit completed, Airtable write-back failed | Result exists but UI is stale | Repair Airtable access/schema, then rerun or perform a controlled write-back |

### Selected-control sweep

The Airtable sweep flow is safe for controls that are confirmed failed or
stale. It:

1. closes old running jobs;
2. restarts evidence sync;
3. records the exact sync ID;
4. waits for sync, audit, worker, and Airtable completion; and
5. reports success in the Audit Overview only after every selected control
   passes the double-check.

Do not treat the initial sweep acknowledgement as the final result.

## Scheduled health checks

### Sweeper cron

```sql
select jobname, schedule, active
from cron.job
where jobname = 'sweep-stuck-jobs';

select status_code, created
from net._http_response
order by created desc
limit 10;
```

Expected: an active schedule and HTTP 200 responses every five minutes.

If responses are 401, compare the function `AUDIT_SHARED_SECRET` with the
database Vault secret `audit_shared_secret`. Both copies must be updated during
rotation.

### Queue health

```sql
select status, count(*)
from audit_queue
group by status;

select status, count(*)
from external_extraction_jobs
group by status;
```

Investigate growing `dead`, `failed`, or long-lived `processing` counts.

## Common incidents

| Symptom | Likely cause | Response |
|---|---|---|
| HTTP 401 | Wrong shared/engagement/Make secret for the endpoint | Identify the endpoint's auth mode; rotate or correct the right secret |
| Airtable field remains blank | Write-back failed or field renamed | Inspect `airtable_sync`; confirm exact field name and token access |
| PDF remains `waiting_external` | Make run active, failed, or callback lost | Open execution URL; correct Make; stale sweeper will eventually close it |
| Evidence ready but no audit | Queue/worker issue | Inspect `audit_queue` and `audit-worker` jobs |
| Whole engagement stops | Pacer sees stale in-flight jobs or capacity is full | Check running syncs, sweep true orphans, resume pacing |
| One file fails | Unsupported/corrupt file, timeout, or extraction error | Inspect `evidence_files.error_message`; correct file and rerun |
| Prompt change has no effect | Markdown was changed but DB prompt was not activated | Sync the intended prompt and verify one active version |
| Airtable script change has no effect | Repository copy was not pasted into Airtable | Publish the script to the correct automation and test |

## Deployment checklist

- [ ] Correct Git branch and reviewed diff
- [ ] Clean working tree
- [ ] Production project ref confirmed
- [ ] Relevant Deno checks and tests passed
- [ ] Database migration dry run reviewed
- [ ] Changed prompts synced separately
- [ ] Affected functions deployed
- [ ] Function versions recorded
- [ ] Airtable script copies published, if changed
- [ ] Make.com scenario version recorded, if changed
- [ ] Focused smoke test passed
- [ ] Rollback reference recorded

## Escalation record

For every incident, capture:

- date/time and reporter;
- engagement and control;
- visible Airtable message;
- relevant Supabase IDs;
- root cause;
- actions taken;
- whether data or conclusions changed;
- follow-up owner; and
- preventive change.

Named technical, audit, Airtable, Google Workspace, Make.com, and billing owners
must be recorded in [HANDOVER.md](HANDOVER.md) before acceptance.
