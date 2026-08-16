// MASTER script — starts Run V3 after the engagement has been registered.
// Reference copy only; Airtable runs its own pasted automation script.
//
// Registration is intentionally handled earlier by the Make.com onboarding
// scenario.
// This script verifies that the Audit Overview row already has both its
// Supabase UUID and per-engagement key, then checks [Run_All_V3_Audits]. That
// checkbox triggers the control-ticking automation.
//
// Required automation inputs:
//   engagementTable — the Audit Overview table ID or name
//   engagementRecordId — the triggering Audit Overview record ID

let config = input.config();
const STATUS_FIELD = "💬";
const RUN_ALL_FIELD = "Run_All_V3_Audits";
const UUID_FIELD = "supabase_uuid";
const KEY_FIELD = "supabase_key";

if (!config.engagementTable) {
  throw new Error("engagementTable is missing.");
}
if (!config.engagementRecordId) {
  throw new Error("engagementRecordId is missing.");
}

const engagements = base.getTable(config.engagementTable);
const record = await engagements.selectRecordAsync(config.engagementRecordId);
if (!record) {
  throw new Error(`Engagement record ${config.engagementRecordId} was not found.`);
}

const engagementUuid = String(record.getCellValueAsString(UUID_FIELD) || "").trim();
const engagementKey = String(record.getCellValueAsString(KEY_FIELD) || "").trim();
if (!engagementUuid || !engagementKey) {
  const message = "Register Engagement before running Run V3.";
  await engagements.updateRecordAsync(config.engagementRecordId, {
    [STATUS_FIELD]: `❌ ${message}`,
  });
  output.set("error", message);
  throw new Error(message);
}

await engagements.updateRecordAsync(config.engagementRecordId, {
  [RUN_ALL_FIELD]: true,
  [STATUS_FIELD]: "Clearcheck is Checking 🎯",
});

output.set("engagement_id", engagementUuid);
output.set("run_all_triggered", true);
