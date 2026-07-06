// MASTER script — runs once per engagement when the [Run V3] button fires.
// Reference copy of the Airtable automation script (Airtable runs its own copy).
//
// 0. Validates required inputs. If any are empty, writes "<field> is missing,
//    please input it." to the engagement record's 💬 status field and stops.
// 1. Calls register-engagement (upsert): creates the engagement if new,
//    updates Drive IDs if it already exists.
// 2. Saves the returned UUID (always) and api_key (create only) back onto
//    the engagement record, sets the 💬 field to "Clearcheck is Checking 🎯",
//    AND checks "Run_All_V3_Audits" in the same atomic write. That checkbox is
//    the TRIGGER for the tick-controls automation (tick-controls-script.js);
//    because the write is atomic, UUID/key are guaranteed present by the time
//    the trigger condition is evaluated.
//
// Input variables (set in the automation's script step):
//   engagementTable, engagementRecordId, clientName, auditType, attestStart,
//   attestEnd, googleDriveId, evidenceFolderId.
//
// Engagement table fields required: supabase_uuid (text),
//   supabase_key (text — mark sensitive; it's a credential),
//   Run_All_V3_Audits (checkbox — the trigger for tick-controls),
//   💬 (text — status / error messages surfaced to the user).
//
// NOTE: BASE and SECRET are hardcoded for the prod project. SECRET must match
// the prod Vault's AUDIT_SHARED_SECRET exactly, or register-engagement rejects
// the call. The shared secret authenticates ONLY this setup call; every
// per-control call afterward uses the engagement's own supabase_key (ADR-011).

let config = input.config();
const BASE = "https://kwuymtlpjkziqkumixvk.supabase.co/functions/v1";
const SECRET = ""; // ← set to the prod AUDIT_SHARED_SECRET value

const HEADERS = {
  "Content-Type": "application/json",
  "x-audit-secret": SECRET, // shared secret — setup call
};

const STATUS_FIELD = "💬";
let engagements = base.getTable(config.engagementTable);

// ── 0. Validate required inputs ─────────────────────────────────────────────
// Friendly label → the input variable it must have. Empty/missing values are
// reported back to the user via the 💬 field instead of failing silently.
const required = {
  "Client Name": config.clientName,
  "Audit Type": config.auditType,
  "Attestation Start": config.attestStart,
  "Attestation End": config.attestEnd,
  "Google Drive ID": config.googleDriveId,
  "Evidence Folder ID": config.evidenceFolderId,
};

let missing = [];
for (let label in required) {
  let v = required[label];
  if (v === undefined || v === null || String(v).trim() === "") {
    missing.push(label);
  }
}

if (missing.length > 0) {
  let msg = `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing, please input it.`;
  // Surface the error on the same record (if we have its id) so the user sees it.
  if (config.engagementRecordId) {
    await engagements.updateRecordAsync(config.engagementRecordId, { [STATUS_FIELD]: msg });
  }
  output.set("error", msg);
  throw new Error(msg);
}

// ── 1. Register (upsert) the engagement ────────────────────────────────────
let regRes = await fetch(`${BASE}/register-engagement`, {
  method: "POST",
  headers: HEADERS,
  body: JSON.stringify({
    airtable_record_id: config.engagementRecordId,
    client_name: config.clientName,
    audit_type: config.auditType,
    attest_start: config.attestStart,
    attest_end: config.attestEnd,
    google_drive_id: config.googleDriveId,
    evidence_folder_id: config.evidenceFolderId,
    // Real Airtable base id (app...) so the write-back path can PATCH records.
    // base.id is the current base — no input variable needed.
    airtable_base: base.id,
    // Engagement table id/name so register-engagement can write base.id back into
    // this row's "app_id" field (visibility + confirms Supabase captured the base).
    airtable_engagement_table: config.engagementTable,
  }),
});

// Defensive parse — a non-JSON body means the function isn't deployed.
let regText = await regRes.text();
let regResult;
try { regResult = JSON.parse(regText); } catch { regResult = { raw: regText }; }
if (!regRes.ok) {
  let msg = `register-engagement failed (HTTP ${regRes.status}): ${regResult.error || regText}`;
  if (config.engagementRecordId) {
    await engagements.updateRecordAsync(config.engagementRecordId, { [STATUS_FIELD]: msg });
  }
  throw new Error(msg);
}

let engagementUuid = regResult.engagement_id;
let engagementKey = regResult.api_key; // present ONLY on first create

// ── 2. Save UUID + key, set status, and flip the trigger — one atomic write.
//        Checking Run_All_V3_Audits fires the tick-controls automation; the
//        atomic write guarantees supabase_uuid/key are present before the
//        trigger evaluates.
let runAllField = "Run_All_V3_Audits";
let fieldsToSave = {
  "supabase_uuid": engagementUuid,
  [runAllField]: true,
  [STATUS_FIELD]: "Clearcheck is Checking 🎯",
};
if (engagementKey) {
  // Only set on create — on a re-click (update) there's no key in the response,
  // and we must NOT overwrite the stored key with a blank value.
  fieldsToSave["supabase_key"] = engagementKey;
}
await engagements.updateRecordAsync(config.engagementRecordId, fieldsToSave);

output.set("created", regResult.created);
output.set("engagement_id", engagementUuid);
output.set("key_issued", !!engagementKey);
output.set("run_all_triggered", true);
