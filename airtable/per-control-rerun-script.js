// PER-CONTROL RE-RUN script — runs once per control when the "Re-run Audit 🤖"
// single-select is set on a control record. Reference copy; Airtable runs its
// own copy.
//
// Handles TWO flows, switched by the SELECTED option:
//
//   • "run"                          → FULL RE-RUN. Re-pulls Drive evidence and
//       re-audits, like the "Run V3 Audit" checkbox — but WITHOUT re-registering.
//       The control is ALREADY in Supabase from the initial run (description,
//       expected procedures, TSC links, control_uuid all persisted), so a re-run
//       does NOT need register-control / refine-control again. It just calls
//       sync-control-evidence(control_uuid); sync re-pulls/ resumes the files and
//       chains to run-audit itself once evidence is ready. Use this to restart a
//       control from scratch (e.g. one stuck mid-ingest) in one click, without the
//       clear-and-recheck dance on the "Run V3 Audit" checkbox.
//   • "run with Additional Evidence" → REMEDIATION (mode=evidence) via rerun-audit
//   • "run with Additional Notes"    → REMEDIATION (mode=notes)    via rerun-audit
//
// The REMEDIATION path (ADR-013) re-judges against the PREVIOUS verdict + the new
// evidence/notes staged on the row; it does NOT re-pull from Drive. The FULL path
// re-pulls everything from Drive, exactly like the first run.
//
// The trigger field is CLEARED FIRST so it behaves like a momentary button:
// re-selecting the same option fires the automation again.
//
// Input variables (set in the automation's script step) — BOTH flows use the same
// small set; no extra control fields are needed because the control already exists
// in Supabase:
//     supabaseKey             — this engagement's api_key (per-engagement key)
//     controlTable            — the controls table name/id (💬 + clearing the field)
//     airtableControlRecordId — this control's record id
//     runClearCheck           — the selected "Re-run Audit 🤖" option value (string)
//     controlUuid             — controls.id (UUID) saved by the initial run
//     runField                — (optional) the field to clear afterwards
//                               (defaults to "Re-run Audit 🤖")
//   REMEDIATION flow also uses:
//     additionalEvidence      — the [Additional Evidence] attachment cell value
//     additionalNotes         — the [Additional Notes] long-text value

let config = input.config();
const BASE = "https://kwuymtlpjkziqkumixvk.supabase.co/functions/v1";
const HEADERS = {
  "Content-Type": "application/json",
  "x-audit-secret": config.supabaseKey,
};

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

// Clear the trigger field FIRST, before any guard below can throw. The field is
// a momentary button: setting it null re-arms it so re-selecting the same option
// fires the automation again. If we cleared it only at the end (after the guards),
// a guard failure would throw with the field still set; re-selecting the same
// value then wouldn't change it, the automation would never re-fire, and the
// auditor would be stuck. Setting it null does NOT re-trigger (the automation
// fires on "set to a value", not on "cleared").
let runField = config.runField || "Re-run Audit 🤖";
if (config.controlTable && config.airtableControlRecordId) {
  try {
    let tbl = base.getTable(config.controlTable);
    await tbl.updateRecordAsync(config.airtableControlRecordId, { [runField]: null });
  } catch (e) {
    console.warn(`Could not clear "${runField}": ${e.message}`);
  }
}

// Which flow? Airtable can hand a single-select over as the choice-name STRING
// ("run") or, in some configs, as an OBJECT ({name:"run"}). Normalize both, then
// branch on MEANING rather than an exact string:
//   • mentions "evidence" → remediation with Additional Evidence
//   • mentions "note(s)"  → remediation with Additional Notes
//   • anything else (i.e. plain "run") → FULL re-run (pull Drive → run-audit)
// This way "run" can never accidentally fall into the remediation guard below.
let rawSel = config.runClearCheck;
let selName = (rawSel && typeof rawSel === "object") ? (rawSel.name || "") : String(rawSel || "");
let selected = selName.trim().toLowerCase();
let wantsEvidence = selected.includes("evidence");
let wantsNotes = selected.includes("note");
let isFull = !wantsEvidence && !wantsNotes; // plain "run" → full pipeline

// ─────────────────────────────────────────────────────────────────────────────
// FULL RE-RUN ("run") — re-pull evidence + re-audit, no re-registration needed.
// The control already exists in Supabase (control_uuid, description, expected
// procedures, TSC links all persisted by the initial run), so we skip
// register-control / refine-control and go straight to sync-control-evidence,
// which re-pulls/resumes the Drive files and chains to run-audit itself.
// ─────────────────────────────────────────────────────────────────────────────
if (isFull) {
  if (!config.controlUuid) {
    await setStatus("❌ Re-run: this control has no control_uuid yet — run the initial 'Run V3 Audit' first.");
    throw new Error("Missing controlUuid for a full ('run') re-run.");
  }

  // sync acks fast (202), owns its own 💬 ("🔎 Pulling evidence…" → "✅/❌"), and
  // chains to run-audit once evidence is ready. So this is the only call needed.
  await setStatus("🔎 Re-running — pulling evidence…");
  let sync = await callFn("sync-control-evidence", { control_uuid: config.controlUuid });
  if (!sync.ok) {
    let msg = `sync-control-evidence failed to start (HTTP ${sync.status}): ${sync.result.error || sync.text}`;
    await setStatus(`❌ ${msg}`);
    throw new Error(msg);
  }

  output.set("flow", "full");
  output.set("control_uuid", config.controlUuid);
  output.set("sync_status", sync.result.status || "accepted");
  output.set("sync_job_run_id", sync.result.job_run_id);
  return;
}

// ─────────────────────────────────────────────────────────────────────────────
// REMEDIATION ("run with Additional Evidence" / "…Notes") — unchanged.
// ─────────────────────────────────────────────────────────────────────────────
if (!config.controlUuid) {
  await setStatus("❌ Re-run: this control has no control_uuid yet — run the initial audit first.");
  throw new Error("Missing controlUuid — run the initial 'Run V3 Audit' first.");
}

// Map the selected option to a mode hint (already computed above).
let mode = wantsNotes ? "notes" : "evidence";

// Normalize the attachment cell → [{url, filename}].
let attachments = Array.isArray(config.additionalEvidence)
  ? config.additionalEvidence
      .filter((a) => a && a.url && a.filename)
      .map((a) => ({ url: a.url, filename: a.filename }))
  : [];
let notes = (config.additionalNotes || "").trim();

// Mode-specific guards — the chosen option must have its named input staged.
if (mode === "evidence" && attachments.length === 0) {
  await setStatus("❌ Please upload the Additional Evidence first.");
  throw new Error("Additional Evidence is empty for an 'additional Evidence' re-run.");
}
if (mode === "notes" && notes === "") {
  await setStatus("❌ Please add the Additional Notes first.");
  throw new Error("Additional Notes is empty for an 'additional Notes' re-run.");
}

let rerun = await callFn("rerun-audit", {
  control_uuid: config.controlUuid,
  mode,
  additional_evidence: attachments,
  additional_notes: notes,
});

if (!rerun.ok) {
  let msg = `rerun-audit failed (HTTP ${rerun.status}): ${rerun.result.error || rerun.text}`;
  await setStatus(`❌ ${msg}`);
  throw new Error(msg);
}

output.set("flow", "remediation");
output.set("mode", mode);
output.set("attachments_sent", attachments.length);
output.set("had_notes", notes.length > 0);
output.set("status", rerun.result.status || "accepted");
output.set("job_run_id", rerun.result.job_run_id);
