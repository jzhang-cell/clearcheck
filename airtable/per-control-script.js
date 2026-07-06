// PER-CONTROL script — runs once per control (fired by "Run V3 Audit" being
// ticked on a control record). Reference copy; Airtable runs its own copy.
//
// Runs four calls IN ORDER:
//   0. register-control      — upsert the control + TSC links.        HARD FAIL.
//   1. refine-control        — polish the description.                BEST-EFFORT.
//   2. sync-control-evidence — Drive → Storage → ingest.              HARD FAIL.
//   3. run-audit             — kicks the Opus/Sonnet pipeline in the BACKGROUND
//      and returns a fast 202 ack. It writes its own results back to Airtable
//      when done; we only await the quick ack here.                   HARD FAIL.
//
// Auth: uses supabaseKey (the per-engagement api_key saved by master-script.js).
// One leaked key only exposes this engagement, not all clients.
//
// Input variables:
//   supabaseKey           — this engagement's api_key (from engagement record,
//                           saved by master-script.js on first [Run V3] click)
//   controlId             — the control's display code, e.g. "CC.01.02"
//                           (maps to controls.control_id; NOT the UUID)
//   companyControl        — (optional) company's own control name/number
//   controlDescription    — (optional) what the control does
//   expectedProcedures    — (optional) how it's tested
//   tscUuids              — (optional) JSON array of Supabase tscs.id UUIDs,
//                           e.g. ["uuid-1","uuid-2"] — already stored in Airtable
//   airtableControlRecordId — (optional) Airtable record id of this control row.
//                           Needed (with controlTable) to write control_uuid back.
//   controlTable          — (optional) the controls table name/id, so the script
//                           can save control_uuid onto the record immediately
//                           after register-control (before steps that can fail).

let config = input.config();
// Hardcoded to the prod functions URL (was config.functionsBaseUrl, which threw
// when the input variable wasn't set). Per-engagement auth still comes from the
// supabaseKey input variable below.
const BASE = "https://kwuymtlpjkziqkumixvk.supabase.co/functions/v1";
const HEADERS = {
  "Content-Type": "application/json",
  // Per-engagement key: identifies this engagement AND authenticates the caller.
  // A leaked key only exposes this one engagement (not all clients).
  "x-audit-secret": config.supabaseKey,
};

// ── Status helper — writes a message to the control record's 💬 field ────────
// Requires controlTable + airtableControlRecordId input vars. Silently skips if
// either is absent (same guard as the UUID write-back below).
async function setStatus(msg) {
  if (!config.controlTable || !config.airtableControlRecordId) return;
  let tbl = base.getTable(config.controlTable);
  await tbl.updateRecordAsync(config.airtableControlRecordId, { "ClearCheck 💬": msg });
}

// Defensive POST: parse text first so a non-JSON body (function not deployed →
// HTML error page) yields a clear error instead of "Unexpected token '<'".
async function callFn(name, body) {
  let res = await fetch(`${BASE}/${name}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  let text = await res.text();
  let result;
  try { result = JSON.parse(text); } catch { result = { raw: text }; }
  return { ok: res.ok, status: res.status, result, text };
}

// ── 0. register-control — HARD FAIL ────────────────────────────────────────
// Parse tscUuids robustly. Airtable can hand this over as a real array (lookup
// field — preferred), a JSON-array string, or a delimiter-separated string
// (rollup with ARRAYJOIN, e.g. "uuid1, uuid2"). Accept all three. We FAIL LOUD
// if the field had content but parsed to zero UUIDs — that catches the silent
// "no TSC links → degraded audit" trap. A genuinely empty field is allowed.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseTscUuids(raw) {
  if (raw === undefined || raw === null) return { list: [], hadContent: false };

  let candidates;
  if (Array.isArray(raw)) {
    candidates = raw;
  } else {
    let s = String(raw).trim();
    if (s === "") return { list: [], hadContent: false };
    if (s.startsWith("[")) {
      // JSON array string.
      try { candidates = JSON.parse(s); } catch { candidates = []; }
    } else {
      // Delimiter-separated (rollup ARRAYJOIN): split on comma/newline/semicolon.
      candidates = s.split(/[,\n;]+/);
    }
  }

  const list = (candidates || [])
    .map((v) => String(v).trim())
    .filter(Boolean)
    .filter((v) => UUID_RE.test(v));

  // hadContent = the field wasn't blank. If it had content but yielded no valid
  // UUIDs, that's a format/config error we must surface, not swallow.
  const hadContent = Array.isArray(raw) ? raw.length > 0 : String(raw).trim() !== "";
  return { list, hadContent };
}

let { list: tscUuidsArray, hadContent: tscHadContent } = parseTscUuids(config.tscUuids);
if (tscHadContent && tscUuidsArray.length === 0) {
  throw new Error(
    `tscUuids was provided but no valid UUIDs were parsed from it ` +
    `(value: ${JSON.stringify(config.tscUuids)}). Check the Airtable field — ` +
    `a lookup of the TSC Supabase-UUID column is expected. Refusing to run ` +
    `with zero TSC links (would degrade the audit).`
  );
}

await setStatus("🤓 Reading control details…");
let regCtrl = await callFn("register-control", {
  control_id: config.controlId,
  ...(config.companyControl ? { company_control: config.companyControl } : {}),
  ...(config.controlDescription ? { control_description: config.controlDescription } : {}),
  ...(config.expectedProcedures ? { expected_procedures: config.expectedProcedures } : {}),
  ...(tscUuidsArray.length > 0 ? { tsc_uuids: tscUuidsArray } : {}),
  ...(config.airtableControlRecordId ? { airtable_record_id: config.airtableControlRecordId } : {}),
});
if (!regCtrl.ok) {
  let msg = `register-control failed (HTTP ${regCtrl.status}): ${regCtrl.result.error || regCtrl.text}`;
  await setStatus(`❌ ${msg}`);
  throw new Error(msg);
}
// Use the returned UUID for all downstream calls — works on first run (no UUID
// in Airtable yet) and on re-runs (same UUID comes back from the upsert).
// Naming: control_id = the code (above); control_uuid = the row's UUID (below).
let controlUuid = regCtrl.result.control_uuid;

// ── Persist the UUID back to Airtable IMMEDIATELY ──────────────────────────
// register-control is the source of truth for control_uuid. Save it now, before
// the steps below that can HARD FAIL (e.g. sync-control-evidence throws while
// Google Drive isn't set up). If we waited until the output.set lines at the
// bottom, a mid-script throw would discard the UUID and the next run would have
// no UUID to re-use. Writing here makes it durable no matter what fails later.
// Requires input vars: controlTable (the controls table name/id) and
// airtableControlRecordId (this control's record id). Field name below must
// match the controls table's UUID field (mirrors the engagement's supabase_uuid).
if (config.controlTable && config.airtableControlRecordId) {
  let controlsTbl = base.getTable(config.controlTable);
  await controlsTbl.updateRecordAsync(config.airtableControlRecordId, {
    "control_uuid": controlUuid,
  });
  console.log(`Saved control_uuid ${controlUuid} to record ${config.airtableControlRecordId}`);
} else {
  // Loud so a missing input var doesn't silently leave control_uuid unsaved.
  console.warn(
    `control_uuid NOT written back — missing input var(s): ` +
    `${!config.controlTable ? "controlTable " : ""}` +
    `${!config.airtableControlRecordId ? "airtableControlRecordId" : ""}`.trim() +
    `. Add them to the script step's input variables.`,
  );
}

// ── 1. refine-control — BEST-EFFORT (continue on failure) ──────────────────
await setStatus("⏳ Polishing control description…"); // step 3 in user-visible sequence
// Runs right after register because it only needs the control's description —
// no evidence required. Moved ahead of sync so run-audit later sees the polished
// description, and so this step still completes when Drive isn't wired up yet.
let refine = await callFn("refine-control", { control_uuid: controlUuid });
if (!refine.ok) {
  console.warn(`refine-control failed (HTTP ${refine.status}): ${refine.result.error || refine.text} — continuing`);
}

// ── 2. sync-control-evidence — kick the background job; await only the 202 ack ──
// sync now ACKS FAST (202) and does the slow Drive pull + per-file ingest in the
// background, then triggers run-audit ITSELF when the evidence is ready. So this
// script no longer waits out the >30s sync (which used to kill it before run-audit
// could start) and no longer calls run-audit directly. sync OWNS its 💬
// ("🔎 Pulling evidence…" → "✅ Evidence ready (N files)." → "❌ …");
// run-audit owns the audit-phase 💬 once sync hands off.
let sync = await callFn("sync-control-evidence", { control_uuid: controlUuid });
if (!sync.ok) {
  // sync already wrote the ❌ to 💬; just stop the pipeline.
  throw new Error(`sync-control-evidence failed to start (HTTP ${sync.status}): ${sync.result.error || sync.text}`);
}

// ── 3. run-audit is intentionally NOT called here ──────────────────────────
// sync-control-evidence chains to run-audit server-side once evidence is ingested.
// This moves the orchestration off the 30s-capped Airtable script so the long
// ingest can't kill it before the audit starts.

output.set("control_uuid", controlUuid);
output.set("tsc_uuids_linked", regCtrl.result.tsc_uuids_linked || []);
output.set("refined", refine.ok);
output.set("sync_status", sync.result.status || "accepted"); // "processing"
output.set("sync_job_run_id", sync.result.job_run_id);
