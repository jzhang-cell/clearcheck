// PER-CONTROL RE-RUN script — runs once per control when the "Re-run Audit 🤖"
// single-select is set on a control record. Reference copy; Airtable runs its
// own copy.
//
// Handles TWO flows, switched by the SELECTED option:
//
//   • "run"                          → FULL RE-RUN. Re-registers the latest
//       Airtable Control Description and Expected Procedures exactly as supplied,
//       re-pulls Drive evidence, and re-audits. No AI refinement runs on a re-run.
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
// Input variables (set in the automation's script step) — all flows use:
//     supabaseKey             — this engagement's api_key (per-engagement key)
//     controlTable            — the controls table name/id (💬 + clearing the field)
//     airtableControlRecordId — this control's record id
//     runClearCheck           — the selected "Re-run Audit 🤖" option value (string)
//     controlUuid             — controls.id (UUID) saved by the initial run
//     controlDescription      — the latest Airtable Control Description (required)
//     expectedProcedures      — the latest Airtable Expected Procedures (required)
//     runField                — (optional) the field to clear afterwards
//                               (defaults to "Re-run Audit 🤖")
//   FULL flow also uses:
//     controlId               — the latest Airtable Control ID
//     companyControl          — (optional) the latest company control value
//   REMEDIATION flow reads [Additional Evidence] and [Additional Notes] directly
//   from the triggering control record. These optional inputs remain as a
//   fallback for bases whose staging fields use different names:
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
  try {
    result = JSON.parse(text);
  } catch {
    result = { raw: text };
  }
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

if (
  typeof config.controlDescription !== "string" ||
  !config.controlDescription.trim() ||
  typeof config.expectedProcedures !== "string" ||
  !config.expectedProcedures.trim()
) {
  await setStatus(
    "❌ Re-run needs the current Control Description and Expected Procedures. Check the automation input mappings.",
  );
  throw new Error("Missing controlDescription or expectedProcedures for a re-run.");
}

// ─────────────────────────────────────────────────────────────────────────────
// FULL RE-RUN ("run") — use current scope directly, re-pull evidence + re-audit.
// register-control marks the supplied Expected Procedures as final for this re-run,
// so sync can queue run-audit without calling refine-control.
// ─────────────────────────────────────────────────────────────────────────────
if (isFull) {
  if (!config.controlUuid) {
    await setStatus(
      "❌ Re-run: this control has no control_uuid yet — run the initial 'Run V3 Audit' first.",
    );
    throw new Error("Missing controlUuid for a full ('run') re-run.");
  }

  if (!config.controlId) {
    await setStatus(
      "❌ Full re-run needs the latest Control ID. Check the automation input mapping.",
    );
    throw new Error("Missing controlId for a full re-run.");
  }

  await setStatus("🤓 Refreshing control details…");
  let regCtrl = await callFn("register-control", {
    control_id: config.controlId,
    ...(config.companyControl ? { company_control: config.companyControl } : {}),
    control_description: config.controlDescription,
    expected_procedures: config.expectedProcedures,
    use_procedures_as_provided: true,
    airtable_record_id: config.airtableControlRecordId,
  });
  if (!regCtrl.ok) {
    let msg = `register-control failed (HTTP ${regCtrl.status}): ${
      regCtrl.result.error || regCtrl.text
    }`;
    await setStatus(`❌ ${msg}`);
    throw new Error(msg);
  }

  let refreshedControlUuid = regCtrl.result.control_uuid;
  if (config.controlTable && config.airtableControlRecordId) {
    let tbl = base.getTable(config.controlTable);
    await tbl.updateRecordAsync(config.airtableControlRecordId, {
      "control_uuid": refreshedControlUuid,
    });
  }

  // sync acks fast (202), owns its own 💬 ("🔎 Pulling evidence…" → "✅/❌"), and
  // chains to run-audit once evidence is ready.
  await setStatus("🔎 Re-running — pulling evidence…");
  let sync = await callFn("sync-control-evidence", { control_uuid: refreshedControlUuid });
  if (!sync.ok) {
    let msg = `sync-control-evidence failed to start (HTTP ${sync.status}): ${
      sync.result.error || sync.text
    }`;
    await setStatus(`❌ ${msg}`);
    throw new Error(msg);
  }

  output.set("flow", "full");
  output.set("control_uuid", refreshedControlUuid);
  output.set("procedures_source", "provided");
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

// Read the staging fields from the live control record instead of relying on
// Airtable's automation input snapshot. This avoids a newly-uploaded attachment
// appearing empty because `additionalEvidence` was missing, stale, or mapped to
// the wrong dynamic value. Configured inputs remain a compatibility fallback.
let liveEvidence;
let liveNotes;
let evidenceFieldFound = false;
let notesFieldFound = false;

if (config.controlTable && config.airtableControlRecordId) {
  try {
    let tbl = base.getTable(config.controlTable);
    let record = await tbl.selectRecordAsync(config.airtableControlRecordId);
    if (record) {
      let evidenceField = tbl.fields.find((field) => field.name === "Additional Evidence");
      let notesField = tbl.fields.find((field) => field.name === "Additional Notes");

      if (evidenceField) {
        evidenceFieldFound = true;
        liveEvidence = record.getCellValue(evidenceField);
      }
      if (notesField) {
        notesFieldFound = true;
        liveNotes = record.getCellValue(notesField);
      }
    }
  } catch (e) {
    console.warn(`Could not read live re-run inputs from the control record: ${e.message}`);
  }
}

let rawEvidence = evidenceFieldFound ? liveEvidence : config.additionalEvidence;
let rawNotes = notesFieldFound ? liveNotes : config.additionalNotes;

// Normalize the attachment cell → [{url, filename}].
let attachments = Array.isArray(rawEvidence)
  ? rawEvidence
    .filter((a) => a && a.url && a.filename)
    .map((a) => ({ url: a.url, filename: a.filename }))
  : [];
let notes = typeof rawNotes === "string" ? rawNotes.trim() : "";

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
  control_description: config.controlDescription,
  expected_procedures: config.expectedProcedures,
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
