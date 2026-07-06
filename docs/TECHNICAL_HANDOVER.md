# SOC 2 ClearCheck — Technical Handover

*For the engineer(s) taking over the system. Assumes general web/backend knowledge, not
prior knowledge of this project.*

---

## 1. What the system does (one paragraph)

ClearCheck is an AI audit pipeline. An auditor ticks a checkbox in **Airtable**; that
triggers a chain of **Supabase Edge Functions** (Deno/TypeScript) which pull a control's
evidence from **Google Drive**, store it in **Supabase Storage**, use the **Claude API** to
read the evidence and judge whether the control is met, then write the verdict and a formal
write-up back into Airtable. Everything is logged to a `job_runs` table for observability.

---

## 2. Tech stack

| Piece | Role |
|---|---|
| **Supabase** | Postgres database, Edge Functions (Deno/TS), Storage (evidence files), Vault (secrets), Cron |
| **Anthropic Claude** | Reading/extracting evidence (Haiku), judging conformity (Opus), writing the workpaper (Sonnet) |
| **OpenAI** | Text embeddings (`text-embedding-3-small`) for evidence search |
| **Airtable** | The auditor-facing UI — the controls grid, buttons, and result fields. Also holds small JavaScript "automation" scripts that call the edge functions. |
| **Google Drive** | Where evidence files live (one folder per control). Pulled via a Google service account with domain-wide delegation. |
| **Deno** | Runtime for the edge functions and the helper scripts. |

**Environments** (check before any remote command with `cat supabase/.temp/project-ref`):

| Environment | Supabase project ref | Notes |
|---|---|---|
| Production | `kwuymtlpjkziqkumixvk` | The live system. |
| Prototype / staging | `hfmhckntrkrllumlkzii` | Old dev project — do not touch unless doing local dev work. |

---

## 3. The end-to-end flow

For one control, when the auditor ticks **Run V3 Audit**, an Airtable script runs these
steps in order (each is an edge function):

```
register-control   → create/update the control + link its criteria (fast, synchronous)
refine-control     → tidy the control's description + expected procedures (Haiku)
sync-control-evidence → pull the Drive folder → Storage → read every file with Claude
                       → attach files to the control → then triggers…
run-audit          → judge conformity (Opus) → write the workpaper (Sonnet)
                     → write the verdict + results back to Airtable
```

A separate **re-run** flow (`rerun-audit`) lets an auditor re-check a control after adding
new evidence or notes, without redoing everything.

**Async design:** the slow steps (`sync-control-evidence`, `run-audit`) return a fast
acknowledgement and keep working in the background, then write their own status into
Airtable's `ClearCheck 💬` field. This is why an Airtable script (which has a ~30-second
limit) never blocks on the slow work. Rule of thumb in the code: *the component doing the
work is the component that writes the status.*

---

## 4. Edge functions (8)

Located in `supabase/functions/`. All use `verify_jwt = false` (see `config.toml`) and log
to `job_runs`.

| Function | What it does |
|---|---|
| **register-engagement** | Creates/updates an engagement (a client audit), mints its per-engagement API key, stores the Airtable base id. Uses the shared secret (it runs before a per-engagement key exists). |
| **register-control** | Creates/updates a control and links its Trust Services Criteria (TSCs). Returns the control's UUID. |
| **refine-control** | Uses Haiku to clean up the control's description and expected procedures. |
| **sync-control-evidence** | The heavy one. Finds the control's Drive folder, downloads each file, stores it, and reads it with Claude (`_shared/ingest-file.ts`). Handles big PDFs, self-chains for large folders, attaches files to the control, then triggers `run-audit`. |
| **run-audit** | Loads the extracted evidence, judges conformity with Opus, renders the workpaper with Sonnet, and writes everything back to Airtable. |
| **rerun-audit** | Remediation re-check: takes the previous verdict plus only the *new* evidence/notes and re-judges (uses the `audit_remediation` prompt). |
| **pace-controls** | Coordinator that throttles how many controls run at once (so a "Run All" doesn't overwhelm the API). |
| **sweep-stuck-jobs** | A scheduled (cron) cleanup that marks orphaned "running" job rows as failed, so the dashboard stays honest if a function was ever killed mid-run. |

Shared code lives in `supabase/functions/_shared/` (~20 modules). Key ones:
`ingest-file.ts` (the ingest pipeline), `extract-by-type.ts` (reads each file type with
Claude), `claude-client.ts` / `openai-client.ts` (API clients with timeouts + retries),
`scoped-db.ts` (per-engagement database access), `auth.ts` / `engagement-key.ts` (API-key
auth), `airtable.ts` (write-backs), `drive-client.ts` (Google Drive), `job-run.ts` (logging).

---

## 5. How evidence is read (the extraction pipeline)

`sync-control-evidence` → `_shared/ingest-file.ts` → `_shared/extract-by-type.ts`. Each file
is classified by type and read by a matching Claude prompt:

- **CSV / spreadsheet** → `extractor_csv` (xlsx is converted to CSV first).
- **Image** → `extractor_image`.
- **Word doc** → `extractor_doc`.
- **PDF ≤ 50 pages** → `extractor_pdf_small` (one Claude call).
- **PDF > 50 pages ("large")** → split into **~10-page sections**, each read with the small-PDF
  reader **in parallel**, then combined mechanically (no separate AI "aggregation" call).

**Important tuning values** (in `extract-by-type.ts` / `sync-control-evidence.ts`, all
env-overridable):

| Setting | Value | Why it matters |
|---|---|---|
| `PDF_SECTION_PAGES` | 10 | Big PDFs are split into 10-page sections. Bigger sections = slower single calls. |
| `PDF_CHUNK_CONCURRENCY` | 12 | How many sections/files read at once. |
| `EXTRACT_TIMEOUT_MS` | 120000 | Per-Claude-call timeout. **Was 60s and caused big PDFs to fail** — a real section takes ~52–75s, so 60s aborted+retried+skipped them. Keep this comfortably above real call times. |
| `PER_FILE_TIMEOUT_MS` | 150000 | Hard ceiling per file in the sync worker, so one hung file can't freeze a control. |
| `SYNC_BUDGET_MS` | 50000 | After this, the function stops launching new files and re-invokes itself (self-chaining) to continue — so a huge folder finishes across several runs. |

> **Legacy note:** the old big-PDF approach used `extractor_pdf_chunk` + `extractor_pdf_aggregator`
> (5-page chunks + an AI combine step). That combine step was too slow for 100+ page PDFs, so
> the code now uses the section approach above. Those two prompts still exist in the DB but are
> **no longer called** — safe to leave, or remove later.

---

## 6. Database

Postgres on Supabase. Migrations in `supabase/migrations/` (0001 → 0014). Core tables:

- **Reference:** `tscs` (the Trust Services Criteria), `prompts` (the AI prompts, loaded at runtime).
- **Engagement:** `engagements`, `engagement_users`.
- **Domain:** `controls`, `control_tscs`, `sample_tests`.
- **Evidence pipeline:** `evidence_files`, `evidence_control_links`, `extracted_evidence`.
- **Audit:** `audit_runs`, `audit_results`.
- **Ops:** `job_runs` (every function call is logged here).

Extensions: `pgvector` (embeddings), `pgcrypto`. Storage bucket: `evidence`.

**Prompts live in the database**, not in code. The `.md` files in `supabase/prompts/` are the
source; `scripts/sync-prompts.ts` upserts them into the `prompts` table. The functions load the
active prompt at runtime (`loadActivePrompt`). To change a prompt's wording or `max_tokens`, edit
the `.md` and re-sync (or update the row directly for a quick config fix).

---

## 7. Security & multi-client isolation

This is live in production (see `SECURITY.md` and `DECISIONS.md` ADR-011 for the full story):

- **Row-Level Security (RLS)** is enabled on all tables. Each engagement's data is tagged with
  its `engagement_id`, and a non-bypass database role (`engagement_scoped`) enforces that a
  request can only see its own engagement's rows (`withEngagementScope()` in `scoped-db.ts`).
- **Per-engagement API keys.** The per-control functions (`register-control`, `refine-control`,
  `sync-control-evidence`, `run-audit`) require the calling engagement's own API key (SHA-256
  hash stored in `engagements.api_key_hash`). This was adversarially tested: engagement A's key
  gets HTTP 404 on engagement B's control.
- **Secrets** (4) live in Supabase Vault: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `AUDIT_SHARED_SECRET`, `AIRTABLE_PAT`. Locally they live in `supabase/functions/.env`
  (gitignored). **Never hardcode a secret.**

---

## 8. The Airtable side

The auditor UI is Airtable. The buttons run small JavaScript "automation" scripts (in the
`airtable/` folder as reference copies) that call the edge functions:

- `master-script.js` — kicks off an engagement (registers it).
- `per-control-script.js` — the per-control run (register → refine → sync → audit chain).
- `per-control-rerun-script.js` — the re-run / remediation flow.
- `tick-controls-script.js` / `tick-controls-via-coordinator.js` — "run many controls" helpers.

These scripts are pasted into Airtable Automations; the files here are the source of truth.
Key result fields on a control: `ClearCheck 💬` (status + verdict), `V3_Conformity_Level`,
`V3_Determination`, `V3_Briefing`, `V3_Results` (workpaper), `V3_Evidence` (attached files),
`V3_Evidence_Count`, `V3_Run_At`, `V3_Cost_USD`.

---

## 9. Deploying

```bash
# 1. Point at production and confirm
supabase link --project-ref kwuymtlpjkziqkumixvk
cat supabase/.temp/project-ref          # confirm it says the prod ref

# 2. Apply any new database migrations
supabase db push

# 3. Sync prompts (if any .md changed)
deno run -A scripts/sync-prompts.ts     # needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env for prod

# 4. Deploy functions (one, several, or all)
supabase functions deploy sync-control-evidence run-audit rerun-audit …

# 5. Secrets (only when they change)
supabase secrets set ANTHROPIC_API_KEY=… OPENAI_API_KEY=… AUDIT_SHARED_SECRET=… AIRTABLE_PAT=…
```

Prompts are read from the DB at runtime, so a prompt/`max_tokens` change takes effect
**without** a function redeploy.

---

## 10. Local development

```bash
supabase start                                   # local Postgres + Storage (needs Docker/OrbStack)
# create supabase/functions/.env with ANTHROPIC_API_KEY, OPENAI_API_KEY, AUDIT_SHARED_SECRET
supabase functions serve --env-file supabase/functions/.env --no-verify-jwt
```

Without `AIRTABLE_PAT`, local runs skip the Airtable write-back (they still do the real work).
Type-check a function before deploying: `deno check supabase/functions/<name>/index.ts`.

> There are two known, harmless type-check warnings (a `tx.json()` JSONValue mismatch in
> `ingest-file.ts` and a `setTimeout` `Timeout`-vs-`number` in `sync-control-evidence.ts`). They
> don't affect runtime and the deploy bundles past them.

---

## 11. Operating & troubleshooting

Everything is logged to **`job_runs`** (function name, status, payload, error, duration,
timestamps). To see what happened, query it:

```sql
-- recent activity for one engagement
select function_name, status, started_at, duration_ms, error_message
from job_runs j join engagements e on e.id = j.engagement_id
where e.airtable_base = '<airtable base id>'
order by started_at desc limit 30;
```

Common things to check:

- **A control seems stuck** → look for a `job_runs` row still `running`. A sync/audit call can
  only live a couple of minutes; anything "running" for longer is an orphan (function was killed).
  `sweep-stuck-jobs` cleans these up automatically; you can also mark them failed by hand.
- **A file didn't extract** → check the `evidence_files` row's `status` and `error_message`, and
  whether it has an `extracted_evidence` row.
- **"1 file failed" on a big PDF** → almost always the extraction is slower than a timeout. See the
  tuning table in Section 5 (`EXTRACT_TIMEOUT_MS`).
- **Live logs** → the Supabase dashboard → Edge Functions → Logs, or `supabase functions logs <name>`.

---

## 12. Where to read more (internal repo docs)

- `ARCHITECTURE.md` — deeper system design, data flow, RLS, scaling.
- `SECURITY.md` — full security posture and known gaps.
- `RUNBOOK.md` — operational procedures.
- `DECISIONS.md` — architecture decision records (why things are the way they are).
- `docs/USER_GUIDE.md` — exactly what the auditor sees and does, step by step.

---

## 13. Handover checklist for the new owner

- [ ] Get access to: the Supabase project (`kwuymtlpjkziqkumixvk`), the Anthropic + OpenAI
      accounts, the Airtable base, and the Google Workspace service account.
- [ ] Confirm the 4 secrets are set in Supabase Vault.
- [ ] Rotate any secrets that were shared during development.
- [ ] Check the **Anthropic API rate-limit tier** — with lots of parallel extraction, a low
      tier can slow big jobs down. (This bit us during development; higher tier = faster.)
- [ ] Do one end-to-end test run on a non-production/test engagement before relying on it.
