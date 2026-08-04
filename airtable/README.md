# Airtable automation scripts (reference copies)

These are **versioned reference copies** of the scripts that run inside Airtable
automations. Airtable holds and runs its own copy — editing these files does
**not** change anything in Airtable. Paste a file's contents into the matching
automation's "Run script" step to update the live version, and update the file
here when you change the live version, so the two stay in sync.

The end-to-end flow is the ADR-012 Drive-driven `[Run V3]` button.

## `master-script.js` — runs **once per engagement** (step 1)

1. Calls `register-engagement` (upsert) with the shared secret.
2. Saves the returned `engagement_id` → `supabase_uuid`, and (create only) the
   returned `api_key` → `supabase_key`.
3. **Checks `Run_All_V3_Audits`** on the engagement record (last, as its own
   write). That checkbox is the trigger for the tick-controls automation below.

## `c2c-analysis-script.js` — import and compare the client's controls

Fired from the Audit Overview table (`tblrb4PpeCCIShcnl`) when `C2C Analysis`
triggers, once per engagement and before controls are audited. The script
discovers the linked tables behind `Baseline Control ID` and `TSC Criteria`,
then makes one fast call to the background `c2c-analysis` function. The Drive
download, Airtable upserts, Claude analysis, and result write-back continue
server-side after the function returns its **202 ack**.

The server finds the immediate `Client Control` child folder beneath the
engagement's saved Google Drive ID and requires exactly one CSV. It identifies
the CSV's Control ID, Control Description, Criteria, and Owner columns; ignores
Expected Evidence, Status, and blank-ID evidence continuation rows; writes the
CSV Control ID into both `Control ID` and the linked `Baseline Control ID`; and
idempotently upserts the controls table keyed on that baseline link. It then
compares each `Control Description` with the linked
`Control Description (Baseline)` lookup and writes:

- `Baseline Change Type` — `✅ No difference`, `🔎 Editorial change`, or
  `🚨 Substantive change`.
- `Baseline Change Suggestion` — the Control ID plus a concise explanation.

**Input variables:** `supabaseKey` and `auditOverviewRecordId`. The latter is
used only by the script to clear the checkbox trigger or surface an immediate
HTTP error; the server resolves the authoritative overview row from the
per-engagement key, so no record ID is trusted from the request.

`Baseline Control ID` and `TSC Criteria` must be linked-record fields, and the
linked tables' primary fields must hold the control IDs and criteria codes used
in the CSV. The CSV `Owner` value is written according to the Airtable Owner
field type reported by the script.

If the folder or its CSV is missing, the overview `💬` field is set to exactly
`Missing Client Control CSV`. When the CSV is found it shows
`Uploading Client Controls`, then the analysis and completion status. Multiple
matching folders or CSV files fail visibly instead of choosing one arbitrarily.

## `tick-controls-script.js` — runs **once per engagement** (step 2, STOPGAP)

Ticks "Run V3 Audit" on every control, which fires the per-control script below
for each one. Ticks in **configurable waves** (default 5, `waveSize`) with a
pause (`pauseMs`, default 4s), skips already-ticked controls, and is **wall-clock
guarded** (~22s) so it never exceeds Airtable's ~30s cap — if it can't pace
everything in budget it ticks the rest un-paced and reports `unpaced` > 0.

> **This is only a stopgap.** Airtable's ~30s cap (and no `setTimeout`) means a
> single run can't pace many controls to completion — it only spreads the initial
> burst. For the real throttle use the `pace-controls` coordinator below. See
> ADR-014.

**Trigger:** an Airtable automation on the engagement table, *When a record
matches conditions → `Run_All_V3_Audits` is checked*, running this script. The
master script sets that checkbox last, so registration + UUID/key are committed
before any control starts syncing evidence. (Reset `Run_All_V3_Audits` to
unchecked afterward, or the next run won't re-trigger.)

## `tick-controls-via-coordinator.js` — runs **once per engagement** (step 2, DURABLE)

The durable replacement for the stopgap above. Makes ONE fast call to the
server-side **`pace-controls`** edge function, which launches controls in paced
waves (keeping in-flight `sync-control-evidence` jobs under a cap so the Postgres
pooler isn't exhausted), with no 30s cap, self-chaining until done. See ADR-014.

**Use this once `pace-controls` is deployed** — point the same engagement
automation (on `Run_All_V3_Audits`) at this script instead of the stopgap.

**Input variables:** `functionsBaseUrl`, `supabaseKey` (the per-engagement
`api_key`), `controlsTableId` (tbl…), `engagementTableId` (tbl…),
`engagementRecordId` (rec… — for the engagement `💬`), `runField` (optional,
defaults to "Run V3 Audit"), `maxConcurrent` (optional — overrides the
coordinator's default cap of 8).

> **Re-running a whole engagement:** clear every control's `Run V3 Audit` field
> first. The coordinator treats a truthy `Run V3 Audit` as "already launched", so
> stale ticks from a prior run would make it skip those controls.

## `per-control-script.js` — runs **once per control** (step 3)

Runs four calls **in order** (each depends on the previous one's DB writes):

1. `register-control` — upsert the control row + TSC links in Supabase. Returns
   the `control_uuid` which all downstream calls use. **Hard fail.**
2. `sync-control-evidence` — pull this control's Drive files → Storage → ingest.
   **Hard fail** (run-audit fails on empty evidence).
3. `refine-control` — polish only the expected procedure; the original control
   description is preserved. **Best-effort** (continue on failure).
4. `run-audit` — returns a fast **202 ack** and runs the Opus/Sonnet pipeline in
   the **background** (it self-reports results back to Airtable when done). The
   script only waits for the ack, so it stays well under Airtable's ~30s script
   cap. **Hard fail** here means the job wasn't *accepted*, not that the audit
   itself failed — watch `job_runs` / the `V3_*` fields for the audit outcome.

**Input variables for step 3:** `functionsBaseUrl`, `supabaseKey` (the
per-engagement `api_key` saved by the master script — NOT the shared secret),
`controlId` (the control's display code, e.g. `"CC.01.02"` — maps to
`controls.control_id`, NOT the UUID), `companyControl` (optional), `controlDescription` (optional),
`expectedProcedures` (optional), `tscUuids` (optional — the TSC Supabase
`tscs.id` UUIDs for this control), `airtableControlRecordId` (optional).

**`tscUuids` field type:** use a **lookup** field on the control's linked-TSC
relation that pulls each TSC's Supabase-UUID column — a lookup returns the UUIDs
as a clean array. A rollup (`ARRAYJOIN`/`ARRAYUNIQUE`) also works; the script
accepts a real array, a JSON-array string, or a comma/newline-separated string.
If the field has content but the script parses **zero** valid UUIDs from it, the
script throws rather than running with no TSC links (which would silently degrade
the audit) — so a misconfigured field fails loud instead of quietly.

## `per-control-rerun-script.js` — runs **once per control** (the "Re-run Audit 🤖" dropdown)

Fired by an automation on the controls table: *when `Re-run Audit 🤖` is set to a
value*. The script CLEARS the field first (momentary button) and then branches on
the **selected option**:

- **`run`** → **FULL re-run**: re-pulls Drive evidence and re-audits, like the
  "Run V3 Audit" checkbox — but it **skips `register-control` / `refine-control`**
  because the control already exists in Supabase (description, expected procedures,
  TSC links, `control_uuid` all persisted from the initial run). It just calls
  `sync-control-evidence(control_uuid)`, which re-pulls/resumes the files and chains
  to `run-audit` itself. Use this to restart a control from scratch (e.g. one
  **stuck mid-ingest**) in one click, no checkbox clear-and-recheck.
- **`run with Additional Evidence`** → remediation, `mode=evidence` via `rerun-audit`.
- **`run with Additional Notes`** → remediation, `mode=notes` via `rerun-audit`.

The remediation path re-judges against the previous verdict + newly-staged
evidence/notes and does **not** re-pull Drive; the full path re-pulls everything.

**Input variables for the automation's script step** (both flows share the same
small set — no extra control fields are needed since the control already exists):
- *Common:* `supabaseKey`, `controlTable`, `airtableControlRecordId`, `runClearCheck`
  (the selected option value), `controlUuid` (the saved `controls.id`), `runField`
  (optional, defaults to `"Re-run Audit 🤖"`).
- *Remediation flow also uses:* `additionalEvidence` (the attachments cell),
  `additionalNotes` (the long-text cell).

## `sweep-stuck-jobs-script.js` — restart the Audit Overview's bad controls

Fired from the Audit Overview row when an operator requests **Sweep stuck jobs**.
It reads `[Failed_Jobs]` directly from the triggering Audit Overview record and
sends those `control_uuid` values to the `sweep-stuck-jobs` function. The function writes progress to table
`tblrb4PpeCCIShcnl`, field `💬`, resolves each control, and launches
`sync-control-evidence`; sync starts the audit only after evidence is ready.

**Input variables:** `supabaseKey`, `auditOverviewRecordId`, and optionally
`functionsBaseUrl`. Do not configure a separate `badControlIds` input.

## Auth note

The master script (`register-engagement`) uses the shared `auditSecret` — it's the
setup call that mints the per-engagement key. All per-control calls (`register-control`,
`sync-control-evidence`, `refine-control`, `run-audit`) and the engagement-level
`c2c-analysis` call use `supabaseKey` instead.
The key both authenticates the caller AND identifies which engagement the call belongs
to — no `engagement_id` in the request body is needed. A leaked key only exposes one
engagement, not all clients.

## Airtable's 30s script cap

Airtable's "Run a script" action is capped at ~30s, and an in-flight `fetch`
counts against it. `run-audit` (Opus, 1–2 min) would blow that, so it acks
immediately and finishes in a Supabase background task. `sync-control-evidence`
can still approach the cap for controls with many evidence files — if that bites
in practice, that's the trigger to pull forward the async-queue ticket
(ADR-006/007) and background sync the same way.

## Current auth boundary (ADR-011)

`register-engagement` uses the shared setup secret. Per-control calls and the
bad-control recovery mode use the engagement's own `supabaseKey`; the key both
authenticates the call and limits it to that engagement.
