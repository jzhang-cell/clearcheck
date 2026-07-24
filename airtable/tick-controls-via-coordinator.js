// TICK-CONTROLS (via coordinator) — the DURABLE fan-out throttle (ADR-014).
// Reference copy; Airtable runs its own copy.
//
// This REPLACES tick-controls-script.js's local busy-wait loop. Instead of
// ticking every control here (bounded by Airtable's ~30s cap, no setTimeout),
// it makes ONE fast call to the server-side `pace-controls` coordinator, which
// launches controls in paced waves — keeping in-flight connection-heavy jobs
// under a cap so the Postgres pooler isn't exhausted (see docs/BATCH_TEST_01.md).
// The coordinator has no 30s cap and self-chains until every control is launched.
//
// Use this once `pace-controls` is deployed. Until then, keep using
// tick-controls-script.js (the stopgap that paces only the initial burst).
//
// Triggered by: automation on the engagement table when "Run_All_V3_Audits" is
// checked (the master script flips that checkbox as its last step).
//
// Input variables (set in the automation's script step):
//   functionsBaseUrl     — e.g. https://<ref>.supabase.co/functions/v1
//   supabaseKey          — this engagement's api_key (per-engagement key)
//   controlsTableId      — Airtable table id of the controls table (tbl...)
//   engagementTableId    — Airtable table id of the engagement table (tbl...)
//   engagementRecordId   — this engagement record's id (rec...) for the 💬 field
//   runField             — (optional) defaults to "Run V3 Audit"
//   maxConcurrent        — (optional) overrides the coordinator's default cap

let config = input.config();
const BASE = String(config.functionsBaseUrl || "").replace(/\/+$/, "");

if (!config.supabaseKey) throw new Error("Missing supabaseKey (per-engagement api_key).");
if (!config.controlsTableId) throw new Error("Missing controlsTableId.");
if (!BASE) throw new Error("Missing functionsBaseUrl.");

let body = {
  controls_table_id: config.controlsTableId,
  engagement_table_id: config.engagementTableId || undefined,
  engagement_record_id: config.engagementRecordId || undefined,
  run_field: config.runField || "Run V3 Audit",
};
if (config.maxConcurrent) body.max_concurrent = Number(config.maxConcurrent);

let res = await fetch(`${BASE}/pace-controls`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-audit-secret": config.supabaseKey },
  body: JSON.stringify(body),
});
let text = await res.text();
let result;
try { result = JSON.parse(text); } catch { result = { raw: text }; }

if (!res.ok) {
  throw new Error(`pace-controls failed (HTTP ${res.status}): ${result.error || text}`);
}

// The coordinator acks fast (202) and paces in the background.
output.set("status", result.status || "pacing");
output.set("job_run_id", result.job_run_id);
output.set("max_concurrent", result.max_concurrent);
