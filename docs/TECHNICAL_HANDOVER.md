# ClearCheck — Technical Handover

This guide is for the engineer responsible for operating, maintaining, and
deploying ClearCheck. It assumes general backend and cloud experience but no
prior knowledge of the project.

Read [HANDOVER.md](../HANDOVER.md) first for ownership and acceptance
requirements.

## 1. Source-alignment status

Production runs in Supabase project `kwuymtlpjkziqkumixvk`.

The `codex/refine-handover-notes` review branch was synchronized from production
source commit `052c55d`. The synchronization includes:

- `audit-worker` and the durable `audit_queue` handoff;
- `make-extraction-callback`;
- migrations `0015`–`0019`;
- `evidence_sync_runs` and `external_extraction_jobs`;
- Airtable `V3_Evidence` priority over Google Drive;
- Make.com execution links and stale-job recovery;
- final sweep verification; and
- the latest refined-control field and prompt changes.

The function, migration, prompt, Airtable, and helper-script trees match that
production source. Do not deploy from the client repository until the draft PR
is reviewed, merged, and tagged as the accepted handover release.

## 2. System summary

ClearCheck is an asynchronous SOC 2 evidence-review pipeline:

```text
Airtable trigger
  → register/refine control
  → select and store evidence
  → extract/index evidence
  → durable audit queue
  → audit judgment + workpaper
  → Supabase records + Airtable write-back
```

The auditor-facing interface is Airtable. Supabase owns workflow state,
storage, isolation, queues, and scheduled recovery. AI providers perform
extraction, judgment, and drafting. Make.com handles only configured large-PDF
extraction.

## 3. Production services

| Service | Purpose | Ownership to confirm |
|---|---|---|
| Supabase | Postgres, Storage, Edge Functions, secrets, cron | Project admins, billing, incident contacts |
| Airtable | Auditor UI and automation scripts | Base owners and automation editors |
| Anthropic | Extraction, refinement, judgment, workpaper drafting | API key, billing, rate-limit tier |
| OpenAI | Evidence embeddings | API key, billing, quota alerts |
| Google Workspace | Drive evidence and service-account delegation | Workspace super admins |
| Make.com | Large-PDF extraction scenario | Organization owner, scenario owner, connections |
| GitHub | Source and release history | Repository admins and branch protection |

### Environments

| Environment | Project reference | Rule |
|---|---|---|
| Production | `kwuymtlpjkziqkumixvk` | Confirm before every remote command |
| Prototype | `hfmhckntrkrllumlkzii` | Historical; never use as a production target |

Check the linked target before a deployment:

```bash
cat supabase/.temp/project-ref
git status -sb
git log -1 --oneline
```

## 4. End-to-end workflow

### Client control import

`c2c-analysis` runs once per engagement, before controls are audited.

1. Airtable calls the function with the engagement key and returns immediately.
2. The function locates the `Client Control` folder directly beneath the
   engagement's stored Google Drive ID and requires exactly one CSV in it.
3. It identifies the Control ID, Control Description, Criteria, and Owner
   columns, and ignores evidence and status continuation rows.
4. It upserts the Airtable controls table, keyed on the linked baseline control,
   and writes the CSV control code into both the plain and linked fields.
5. It sends each control's ID, current description, and baseline description to
   Claude, which classifies the difference.
6. It writes `Baseline Change Type` and `Baseline Change Suggestion` back to
   each control row.

A missing folder or CSV sets the Audit Overview `💬` field to
`Missing Client Control CSV`. Multiple matching folders or CSV files fail
visibly instead of selecting one arbitrarily.

### Initial audit

1. Airtable calls `register-control`.
2. Airtable calls `refine-control`.
3. `sync-control-evidence` chooses the evidence source:
   - if `V3_Evidence` contains attachments, it uses those attachments and
     skips Google Drive;
   - otherwise it reads the control's Google Drive subfolder.
4. Each selected file is stored in the private Supabase `evidence` bucket and
   hashed for deduplication.
5. Ordinary files are extracted in Supabase. A PDF over 50 pages is sent to
   Make.com when the external path is configured.
6. Make.com returns the document-level extraction to
   `make-extraction-callback`.
7. When every file is ready, `sync-control-evidence` inserts a durable
   `audit_queue` row.
8. `audit-worker` claims that row and runs the shared audit pipeline.
9. The audit pipeline creates `audit_runs` / `audit_results`, writes the
   workpaper and result fields to Airtable, and marks the queue row done.

The initial HTTP calls acknowledge quickly. Completion is represented by
database state and the final Airtable message—not by the initial `202`.

### Re-run modes

`Re-run Audit 🤖` has two different behaviors:

- **Run:** starts a fresh evidence sync and audit for the existing control.
- **Run with Additional Evidence / Additional Notes:** runs a remediation pass
  using the prior conclusion plus only the new attachments or notes.

Every re-run supplies the current Airtable Control Description and Expected
Procedures and uses them exactly as provided; `refine-control` is not called
again, because those inputs are already auditor-approved. Where the scope has
changed, the superseded determination is withheld from the remediation prompt so
obsolete testing steps cannot be carried forward.

If a control has no previous verdict, remediation has nothing to re-assess. The
staged evidence is ingested and the standard audit pipeline produces a first
result instead of returning an error.

Remediation attachments currently use the local extractor path. The Make.com
continuation belongs to the durable initial evidence-sync path.

### Whole-engagement runs

`pace-controls` launches controls in bounded waves. It gates on active
evidence-sync work, applies a global cap, and fair-shares capacity across
engagements. The Airtable coordinator script should call this function instead
of ticking every control at once.

## 5. Edge functions

The complete production system contains eleven functions:

| Function | Authentication | Responsibility |
|---|---|---|
| `register-engagement` | Shared system secret | Upsert engagement, store Airtable/Drive identifiers, mint an engagement key. Called by the Make.com onboarding scenario |
| `c2c-analysis` | Engagement key | Import the Client Control CSV, upsert Airtable controls, and classify baseline description changes |
| `register-control` | Engagement key | Upsert control and TSC links |
| `refine-control` | Engagement key | Refine the expected procedures only; the original control description is preserved |
| `sync-control-evidence` | Engagement key | Select, store, extract, and finalize evidence; enqueue audit |
| `make-extraction-callback` | Make callback secret | Complete or fail an external large-PDF job and resume its sync |
| `audit-worker` | Shared system secret | Claim durable audit jobs and run the audit pipeline |
| `run-audit` | Engagement key | Direct entry point to the shared audit pipeline |
| `rerun-audit` | Engagement key | Reassess a prior result using new evidence or notes; runs a first audit when there is no prior result |
| `pace-controls` | Engagement key | Pace engagement-wide launches |
| `sweep-stuck-jobs` | Shared secret or engagement key, by mode | Clean stale work and recover selected controls |

All functions use `verify_jwt = false`; authorization is enforced in the
handler. Client-data access then runs through the scoped database role so RLS
applies.

## 6. Durable state and source of truth

| Table | Purpose |
|---|---|
| `job_runs` | Operational log for function work |
| `evidence_sync_runs` | One durable initial evidence-sync lifecycle |
| `external_extraction_jobs` | Make.com jobs, callbacks, errors, and execution URLs |
| `audit_queue` | Durable sync-to-audit handoff with retries and leases |
| `audit_runs` | Audit/remediation lifecycle and evidence snapshot |
| `audit_results` | Final structured conclusion and rendered workpaper |
| `evidence_files` | Stored-file identity, hash, status, and metadata |
| `extracted_evidence` | Structured extraction and embedding |
| `evidence_control_links` | Evidence-to-control relationship |
| `controls` | Current control state and latest audit pointer |
| `prompts` | Versioned runtime AI configuration |

Airtable is the user interface, not the workflow source of truth. Diagnose a
problem from Supabase first, then compare the Airtable write-back.

The complete production schema currently includes migrations through `0019`.
Migrations are forward-only. Never edit a migration that has already been
applied; add a new migration.

## 7. Evidence extraction

| File type | Normal path |
|---|---|
| CSV / spreadsheet | Convert if needed, then `extractor_csv` |
| Image | `extractor_image` |
| Word document | `extractor_doc` |
| PDF up to 50 pages | `extractor_pdf_small` |
| PDF over 50 pages | Make.com Stage 1 chunks + Stage 2 aggregation, when configured |

Supabase always retains responsibility for file identity, Storage, hashing,
deduplication, embeddings, database writes, Airtable mirroring, and audit
enqueueing. Make.com must not write ClearCheck tables or start audits.

The Make callback is idempotent. Its payload includes the job ID, completion
status, structured extraction, token counts, Make execution ID, and a direct
execution URL for debugging.

## 8. Prompts and models

Prompt Markdown in `supabase/prompts/` is the version-controlled source. Runtime
functions load the active row from the `prompts` table.

Therefore:

- editing a prompt file does not change production;
- syncing a prompt changes production without redeploying the function;
- each meaningful change should use a new prompt version;
- sync only the intended prompt when possible; and
- verify that exactly one row for the prompt key is active.

`control_refiner` requires expected procedures to use past-tense
audit-performance wording such as “Inquired” and “Inspected.” It now returns
only the refined expected procedure. The original control description is
preserved end to end, and `refine-control` clears the legacy
`V3_Refined__Control_Description` field so earlier AI wording cannot be mistaken
for the source control.

`c2c_analysis` classifies each client control description against its baseline
as no difference, an editorial change, or a substantive change. It receives only
the control ID and the two descriptions.

## 9. Authentication, isolation, and secrets

### Authentication boundaries

- `register-engagement`, cron, and `audit-worker` use
  `AUDIT_SHARED_SECRET`.
- Engagement-scoped functions use a per-engagement API key. The key identifies
  the engagement and limits the blast radius of exposure.
- `make-extraction-callback` uses `MAKE_WEBHOOK_SECRET`.
- Client data is queried as the non-bypass `engagement_scoped` database role
  with `app.current_engagement_id` stamped per transaction.

### Required production configuration

Confirm these through `supabase secrets list` and the approved password manager.
Do not place secret values in tickets, chat, documentation, shell history, or
Git.

| Name | Sensitivity | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret | Claude requests |
| `OPENAI_API_KEY` | Secret | Embeddings |
| `AIRTABLE_PAT` | Secret | Airtable reads and write-backs |
| `AUDIT_SHARED_SECRET` | Secret | System-function authentication |
| `SUPABASE_DB_URL` | Secret | Scoped direct-Postgres connection |
| `GOOGLE_SA_JSON` | Secret | Google service-account credentials |
| `GOOGLE_DRIVE_SUBJECT` | Configuration | Delegated Google Workspace subject |
| `MAKE_LARGE_PDF_WEBHOOK_URL` | Sensitive configuration | Make.com inbound webhook |
| `MAKE_WEBHOOK_SECRET` | Secret | Make request/callback authentication |

Supabase automatically injects its URL and service-role credentials into Edge
Functions.

### Cron-secret duplication

The scheduled sweeper reads `audit_shared_secret` from database Vault, while
Edge Functions read `AUDIT_SHARED_SECRET` from function secrets. Rotating one
does not rotate the other. Update and test both copies whenever the system
secret changes.

## 10. Airtable deployment boundary

The files under `airtable/` are reference copies. Airtable runs its own pasted
copies inside automations.

After any Airtable-script change:

1. update and review the repository file;
2. paste that exact version into the intended Airtable automation;
3. verify all automation input variables;
4. run a test record; and
5. record who changed the live automation and when.

Relevant fields include:

- `ClearCheck 💬`
- `V3_Evidence`
- `V3_Conformity_Level`
- `V3_Determination`
- `V3_Briefing`
- `V3_Results`
- `V3_Done_At`
- `V3_Cost_USD`
- `V3_Refined__Control_Description` (cleared by `refine-control`)
- `V3_Refined_Expected_Procedure`
- `Baseline Change Type`
- `Baseline Change Suggestion`

`c2c-analysis` additionally requires `Baseline Control ID` and `TSC Criteria` to
be linked-record fields whose linked tables hold the control codes and criteria
codes used in the CSV.

The shared Airtable PATCH helper retries after removing unknown optional fields,
but required schema changes still need coordinated testing.

## 11. Safe deployment procedure

### Before changing production

```bash
git status -sb
git fetch origin
cat supabase/.temp/project-ref
supabase functions list
supabase migration list
```

Then:

1. work on a branch and review the diff;
2. run type checks and the relevant tests;
3. confirm the target project is production;
4. apply migrations before code that depends on them;
5. sync only changed prompts;
6. deploy only affected functions; and
7. perform a focused smoke test.

Example:

```bash
supabase db push --dry-run
supabase db push

PROMPT_KEY=control_refiner \
deno run --allow-read --allow-env --allow-net scripts/sync-prompts.ts

supabase functions deploy refine-control --use-api
supabase functions list
```

Use credentials supplied by the approved secret-management process. Do not put
real values into a committed command example.

### Rollback

- **Function:** redeploy the last known-good commit.
- **Prompt:** reactivate the prior prompt version and verify one active row.
- **Airtable script:** restore the last reviewed reference copy.
- **Database:** use a new corrective migration; do not rewrite applied history.

## 12. Monitoring

### Recent function work

```sql
select function_name, status, engagement_id, started_at, completed_at,
       error_message, result
from job_runs
order by started_at desc
limit 100;
```

### Evidence and Make.com

```sql
select id, control_uuid, status, total_files, error_message,
       created_at, completed_at
from evidence_sync_runs
order by created_at desc
limit 30;

select id, sync_run_id, filename, status, provider_execution_id,
       provider_execution_url, error_message, updated_at
from external_extraction_jobs
order by queued_at desc
limit 50;
```

### Audit queue

```sql
select id, control_uuid, status, attempts, visible_at,
       lease_expires_at, last_error, enqueued_at
from audit_queue
order by enqueued_at desc
limit 50;
```

### Sweeper health

```sql
select jobname, schedule, active
from cron.job
where jobname = 'sweep-stuck-jobs';

select status_code, created
from net._http_response
order by created desc
limit 10;
```

Expected successful cron calls return HTTP 200 every five minutes.

## 13. Troubleshooting order

Use this sequence rather than relying only on the Airtable message:

1. Identify the engagement and Supabase control UUID.
2. Read the latest relevant `job_runs`.
3. Check the exact `evidence_sync_runs` row.
4. If external, inspect `external_extraction_jobs` and open its Make execution
   URL.
5. Check `audit_queue`, then `audit_runs` and `audit_results`.
6. Inspect the job's `result.airtable_sync`.
7. Only then compare the Airtable fields.

| Symptom | First checks | Normal recovery |
|---|---|---|
| Evidence status is frozen | `evidence_sync_runs`, file statuses, latest sync job | Use full **Run** or selected-control sweep after confirming no live work |
| Large PDF waits too long | External job status, `updated_at`, Make execution URL | Fix Make failure or allow sweeper to close stale job, then run again |
| Evidence is complete but no audit starts | `audit_queue`, `audit-worker` jobs | Repair queue/worker issue; do not start audit before evidence completion |
| Audit completed but Airtable is stale | `job_runs.result.airtable_sync`, Airtable field names | Correct Airtable schema/token and retry write-back or rerun |
| Cron returns 401 | Function secret versus database Vault copy | Update both copies and verify the next cron response |
| Whole engagement stops launching | Stale running jobs and pacer result | Run cleanup/sweep, then restart pacing |

## 14. Recovery semantics

The selected-control sweep:

1. marks stale jobs failed;
2. restarts evidence sync for each selected control;
3. records the exact sync IDs;
4. waits for sync, audit, worker, and Airtable write-back completion; and
5. writes a green Audit Overview message only after every selected control
   passes all checks.

An initial “started” response is not proof of completion.

## 15. Known limitations and risks

- AI results require human review and are not deterministic.
- Airtable is not a transactional workflow engine; its displayed state can lag
  Supabase.
- Airtable scripts and database prompts require separate publication steps.
- Per-engagement keys do not provide per-user attribution.
- The system has no customer-facing rate limiter or automated cost-anomaly
  detection.
- Large-PDF reliability depends on Make.com and its connected PDF/AI services.
- Make.com external extraction is not yet used for remediation attachments.
- The synchronized review branch must be approved and merged before the client
  repository becomes the release source of truth.

## 16. Acceptance

Complete the master checklist in [HANDOVER.md](../HANDOVER.md), then record:

- accepted production commit/tag;
- deployed function versions;
- latest applied migration;
- active prompt versions;
- Airtable automation versions;
- Make.com scenario version;
- service owners and incident contacts; and
- handover acceptance date.
