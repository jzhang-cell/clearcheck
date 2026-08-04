// C2C ANALYSIS script — runs once per engagement when [C2C Analysis] triggers.
// Reference copy only; Airtable runs its own pasted automation script.
//
// The script discovers the linked tables behind [Baseline Control ID] and
// [TSC Criteria], then makes one fast call to the background Supabase function.
// Google Drive download, Airtable upserts, Claude analysis, and result write-back
// continue server-side after the function returns its 202 acknowledgement.
//
// Required automation input:
//   supabaseKey — the engagement's per-engagement key from [supabase_key]
//
// Trigger record: the current Audit Overview row. The function resolves that row
// from the key, so no record ID is trusted from the script request.

let config = input.config();
const BASE = "https://kwuymtlpjkziqkumixvk.supabase.co/functions/v1";
const OVERVIEW_TABLE_ID = "tblrb4PpeCCIShcnl";
const CONTROLS_TABLE_ID = "tblZrxDzOKd9FJkbC";
const TRIGGER_FIELD = "C2C Analysis";
const STATUS_FIELD = "💬";

const overviewTable = base.getTable(OVERVIEW_TABLE_ID);
const controlsTable = base.getTable(CONTROLS_TABLE_ID);

if (!config.supabaseKey || String(config.supabaseKey).trim() === "") {
  throw new Error("supabaseKey is missing. Map it from the Audit Overview record.");
}

function linkedTableDetails(fieldName) {
  const field = controlsTable.getField(fieldName);
  const linkedTableId = field.options && field.options.linkedTableId;
  if (field.type !== "multipleRecordLinks" || !linkedTableId) {
    throw new Error(`[${fieldName}] must be an Airtable linked-record field.`);
  }
  const linkedTable = base.getTable(linkedTableId);
  return {
    tableId: linkedTable.id,
    matchField: linkedTable.primaryField.name,
  };
}

const baseline = linkedTableDetails("Baseline Control ID");
const criteria = linkedTableDetails("TSC Criteria");
const ownerField = controlsTable.getField("Owner");

let triggerRecordId = config.auditOverviewRecordId;
if (!triggerRecordId) {
  throw new Error(
    "auditOverviewRecordId is missing. Map the triggering Audit Overview record ID.",
  );
}

try {
  const response = await fetch(`${BASE}/c2c-analysis`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-audit-secret": config.supabaseKey,
    },
    body: JSON.stringify({
      baseline_table_id: baseline.tableId,
      baseline_match_field: baseline.matchField,
      tsc_table_id: criteria.tableId,
      tsc_match_field: criteria.matchField,
      owner_field_type: ownerField.type,
      trigger_source: "airtable",
    }),
  });

  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = { raw: text };
  }
  if (!response.ok) {
    const message = `c2c-analysis failed (HTTP ${response.status}): ${result.error || text}`;
    await overviewTable.updateRecordAsync(triggerRecordId, {
      [STATUS_FIELD]: `❌ ${message}`,
    });
    throw new Error(message);
  }

  output.set("accepted", result.accepted === true || result.success === true);
  output.set("job_run_id", result.job_run_id || "");
  output.set("status", result.status || "complete");
} finally {
  // Treat a checkbox trigger as a momentary action so the auditor can run C2C
  // again after replacing the CSV. Buttons and other field types are untouched.
  const triggerField = overviewTable.getField(TRIGGER_FIELD);
  if (triggerField.type === "checkbox") {
    await overviewTable.updateRecordAsync(triggerRecordId, { [TRIGGER_FIELD]: false });
  }
}
