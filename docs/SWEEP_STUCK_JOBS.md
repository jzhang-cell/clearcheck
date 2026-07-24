# sweep-stuck-jobs — cleanup watchman + bad-control recovery

> Code: `supabase/functions/sweep-stuck-jobs/` (main file `index.ts`, stuck-job
> decisions in `sweep-logic.ts`, Airtable recovery parsing in `recovery-logic.ts`,
> tests alongside both). Airtable caller: `airtable/sweep-stuck-jobs-script.js`. Schedule: migration
> `supabase/migrations/0013_cron_sweep_stuck_jobs.sql`.

The endpoint has two modes:

1. **Scheduled cleanup** — cron authenticates with `AUDIT_SHARED_SECRET`, finds
   old `running` rows across all engagements, and marks them failed. It also
   closes Make extraction jobs that have produced no callback for two hours.
2. **Airtable recovery** — an engagement's Airtable automation authenticates
   with its per-engagement key and sends the `[Failed_Jobs]` control UUIDs as
   `bad_control_ids`. The function resolves
   those controls, reports progress on the Audit Overview row, clears their old
   stuck rows, and restarts their evidence-sync → audit pipelines.

## What problem does it solve?

Every piece of work ClearCheck does (reading a file, syncing evidence, running an
audit) is done by a **worker** — a small program that lives for a few minutes at
most. Each worker writes a row in the `job_runs` table saying "I'm running", and
updates it to "success" or "failed" when it finishes.

But sometimes the platform **kills a worker mid-job** (it ran out of time or
memory). A killed worker cannot write its own "I failed" note — so its row says
**"running" forever**. We call these rows **orphans** or **stuck jobs**.

Stuck jobs are not just messy — they are **dangerous**:

1. **They jam the whole pipeline.** The pacing system (`pace-controls`) counts
   "running" jobs to decide how many new audits it may launch (max 8 at once).
   Orphan rows look like real work, so enough of them make the pacer believe the
   system is full — and it launches **nothing, forever**. This exact thing caused
   a day-long "zero audits launch" outage in Batch Test 05 (143 orphans).
2. **They lie to the auditor.** The control's progress bar stays frozen at
   "📄 Reading your evidence… 2 of 8 files" with no error, so a human thinks it
   is still working.

Something **outside** the workers has to notice the corpses and clean them up.
That is this function. Think of it as the **night guard** who walks the floor,
finds workers that died at their desk, corrects the records, and leaves a note
for the day shift.

## What does scheduled cleanup do?

Step by step (see `index.ts`):

1. **Scan** — read every `job_runs` row whose status is still `running`.
2. **Decide** (pure logic in `sweep-logic.ts`, function `planSweep`) — a row is
   declared dead only if **all** of these are true:
   - status is `running` (finished rows are never touched);
   - it is **older than 8 minutes** (`STUCK_THRESHOLD_MIN`) — no real worker can
     live that long, so an older "running" row must be a corpse;
   - it is **not the sweeper's own row** (the guard never arrests himself);
   - its timestamp is readable (unparseable rows are skipped, never guessed).
3. **Correct the record** — each dead row is updated to `failed` with the note:
   *"Swept by watchman: stuck in 'running' for N minutes (worker timed out /
   was killed before it could self-report)."*
4. **Return compatibility metadata** — for old evidence-sync/re-run rows, the
   cleanup response still includes `controls_to_notify`. Scheduled callers do
   not consume that list. Restarting and visible progress now belong to the
   explicit Airtable bad-control recovery mode below.
5. **Log itself** — the sweep is itself a `job_runs` row, with a result like
   `{"scanned": 18, "swept": 18, "external_swept": 1, "to_notify": 3, ...}`
   so you can see what it did.

Make jobs use a separate, conservative cutoff (`MAKE_EXTERNAL_STALE_MS`, default
two hours) because legitimate large reports can take much longer than an Edge
Function. When one is closed, the watchman marks its sync/evidence state failed
and directly writes a retry message to the affected control. Ordinary
`job_runs` cleanup retains the response-only notification behavior below.

> **Note:** ordinary `job_runs` cleanup returns `controls_to_notify` for backward
> compatibility but does not restart controls or write Airtable messages. Stale
> Make extraction is the exception: it writes its failure/retry message directly
> so a lost callback cannot leave the control looking active forever.

If nothing is stuck, it reports `swept: 0` and exits. Running it is **always
safe, any time** — it can never touch live work (live rows are younger than 8
minutes by definition).

## How Airtable bad-control recovery works

The Airtable automation uses `airtable/sweep-stuck-jobs-script.js` with these
input variables:

| Input | Meaning |
|---|---|
| `supabaseKey` | The current engagement's per-engagement API key |
| `auditOverviewRecordId` | The triggering row in Audit Overview table `tblrb4PpeCCIShcnl` |
| `functionsBaseUrl` | Optional functions URL override |

The script reads `[Failed_Jobs]` directly from the Audit Overview record; do not
configure a separate `badControlIds` input. The normal backend contract is an
array of Supabase control UUIDs. The endpoint also tolerates Airtable linked-record objects,
JSON-array text, comma/newline-separated text, Airtable record IDs, and display
control codes for manual debugging.

The function then:

1. Resolves the IDs only inside the engagement identified by `supabaseKey`.
2. Writes `🧹 Sweeping the total X jobs.` to field `💬` on the supplied Audit
   Overview record.
3. Marks old `running` `job_runs` rows for those controls failed.
4. Calls `sync-control-evidence` once for each matched control (five launch calls
   at a time by default).
5. `sync-control-evidence` processes all evidence and, when finished, inserts a
   durable `audit_queue` row. `audit-worker` then runs the same shared pipeline
   used by `run-audit`. This preserves the required ordering; the sweeper never
   calls `run-audit` while evidence is still processing.
6. Saves a durable verification checklist containing the exact sync run for
   every restarted control.
7. Each scheduled watchman pass double-checks every pending recovery:
   - that exact `evidence_sync_runs` row is `completed`;
   - a new `audit_runs` row completed after the sweep began;
   - the corresponding `run-audit` job succeeded and reports a successful
     Airtable write-back;
   - the control's Airtable `ClearCheck 💬` actually says `🥳 Audit complete`.
8. Only after every selected control passes all four checks, writes this final
   message to `💬` on table `tblrb4PpeCCIShcnl`:
   `✅ Sweep complete — double-check passed. All X controls finished
   successfully and Airtable results are updated.`

While work remains, the overview reports `X/Y controls complete`. A terminal
failure identifies the controls that still need attention. A recovery that
never reaches a terminal state times out after four hours by default and reports
the unfinished control codes instead of claiming success.

The HTTP request receives a fast `202` in production while dispatch continues
in the edge-runtime background.

## Ways the endpoint runs

| How | When | Who set it up |
|---|---|---|
| **Automatic cleanup (cron)** | Every 5 minutes | Shared secret; marks old running rows failed |
| **Bad-control recovery (Airtable)** | Operator selects Sweep; `[Failed_Jobs]` supplies control UUIDs | Per-engagement key; restarts selected controls and writes Audit Overview progress |
| **Direct cleanup (API)** | Debugging/emergencies | Shared secret with no `bad_control_ids` |
| **Direct recovery (API)** | Debugging selected controls | Per-engagement key plus `bad_control_ids` and `airtable_overview_record_id` |

## How it authenticates (and the trap we fell into)

Scheduled cleanup is a **system-wide** operation, so it uses the shared
`AUDIT_SHARED_SECRET`. Bad-control recovery is engagement-scoped and uses that
engagement's `supabaseKey`. Both are sent in `x-audit-secret`; the request body
determines which authentication mode applies.

**The trap (learned the hard way on 2026-07-20):** the cron reads its copy of the
secret from the **database Vault** (secret name `audit_shared_secret`), which is
a *separate copy* from the function secret. When `AUDIT_SHARED_SECRET` was
rotated on 2026-06-25, the Vault copy was not updated — so the cron knocked every
5 minutes for almost a month and got **401 Unauthorized** every time. And because
a 401 is rejected *before* the function logs anything, there was **zero trace**:
everyone believed the cron "was never set up".

> **Rule: whenever `AUDIT_SHARED_SECRET` is rotated, also run:**
> `select vault.update_secret((select id from vault.secrets where name='audit_shared_secret'), '<new value>');`
> (The shared secret is also used by the Airtable Register Engagement setup
> script. The new bad-control sweep script uses `supabaseKey`, not this shared
> secret.)

## How to check it's alive

```sql
-- Is the schedule on?
select jobname, schedule, active from cron.job where jobname = 'sweep-stuck-jobs';

-- Did the last knocks succeed? (expect status_code 200 every 5 minutes)
select status_code, created from net._http_response order by created desc limit 5;

-- What has it actually done lately?
select status, result, started_at from job_runs
 where function_name in ('sweep-stuck-jobs', 'sweep-stuck-jobs-recovery')
 order by started_at desc limit 10;
```

If `net._http_response` shows **401**: the Vault secret is stale again — see the
rule above. If there are no rows at all: the cron schedule is off — re-apply
migration 0013.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `STUCK_THRESHOLD_MIN` | 8 | Minutes after which a "running" row is declared dead |
| `SWEEP_RECOVERY_CONCURRENCY` | 5 | Maximum simultaneous sync launch calls in recovery mode |
| `SWEEP_VERIFICATION_TIMEOUT_MIN` | 240 | Maximum time to double-check an Airtable recovery before reporting unfinished controls |

## Completion semantics

Evidence syncing and auditing remain asynchronous. The initial overview message
means the jobs were accepted. The final green `Sweep complete` message is
different: it is written only after Supabase state and each control's Airtable
result have both been checked.
