// SWEEP BAD CONTROLS script — reference copy for the Airtable automation on
// the Audit Overview row. Airtable runs its own pasted copy of this file.
//
// Required automation input variables:
//   supabaseKey              — this engagement's per-engagement API key
//   auditOverviewRecordId    — triggering row id in table tblrb4PpeCCIShcnl
// Optional:
//   functionsBaseUrl         — defaults to the production functions URL
//
// The script reads [Failed_Jobs] directly from the triggering Audit Overview
// record. Do not add a separate badControlIds automation input.
//
// The function—not this script—writes the Audit Overview [💬] status. It first
// writes "Sweeping the total X jobs", then launches sync-control-evidence for
// every matched control. Sync starts the audit only after evidence is ready.
// The scheduled watchman then double-checks every control and writes the final
// "all controls finished successfully" message only after sync, audit, and the
// control's Airtable result are all confirmed.

const config = input.config();
const BASE = config.functionsBaseUrl ||
  "https://kwuymtlpjkziqkumixvk.supabase.co/functions/v1";

function valueToId(value) {
  if (typeof value === "string" || typeof value === "number") {
    const normalized = String(value).trim();
    return normalized || null;
  }
  if (value && typeof value === "object") {
    for (const key of ["id", "control_uuid", "control_id", "airtable_record_id", "name"]) {
      const candidate = valueToId(value[key]);
      if (candidate) return candidate;
    }
  }
  return null;
}

function parseBadControlIds(raw) {
  let values;
  if (Array.isArray(raw)) {
    values = raw;
  } else if (raw === undefined || raw === null || String(raw).trim() === "") {
    return [];
  } else {
    const text = String(raw).trim();
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        values = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        values = text.split(/[,;\n]+/);
      }
    } else {
      values = text.split(/[,;\n]+/);
    }
  }

  const seen = new Set();
  const ids = [];
  for (const value of values) {
    const id = valueToId(value);
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  return ids;
}

if (!config.supabaseKey) throw new Error("Missing automation input: supabaseKey");
if (!config.auditOverviewRecordId) {
  throw new Error("Missing automation input: auditOverviewRecordId");
}

const overviewTable = base.getTable("tblrb4PpeCCIShcnl");
const overviewRecord = await overviewTable.selectRecordAsync(config.auditOverviewRecordId);
if (!overviewRecord) {
  throw new Error(`Audit Overview record ${config.auditOverviewRecordId} was not found`);
}

const badControlIds = parseBadControlIds(overviewRecord.getCellValue("Failed_Jobs"));
if (badControlIds.length === 0) {
  throw new Error("[Failed_Jobs] did not contain any control_uuid values");
}

const response = await fetch(`${BASE}/sweep-stuck-jobs`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-audit-secret": config.supabaseKey,
  },
  body: JSON.stringify({
    bad_control_ids: badControlIds,
    airtable_overview_record_id: config.auditOverviewRecordId,
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
  throw new Error(
    `sweep-stuck-jobs failed (HTTP ${response.status}): ${result.error || text}`,
  );
}

output.set("sweep_job_run_id", result.job_run_id || null);
output.set("requested", result.requested || badControlIds.length);
output.set("matched", result.matched || 0);
output.set("unmatched", result.unmatched || []);
output.set("status", result.status || "accepted");
