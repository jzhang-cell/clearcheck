// register-engagement — UPSERTS an engagement and stamps its Google Drive IDs.
// Called ONCE per engagement at the start of an Airtable [Run V3] run (step 4.1),
// before the per-control loop.
//
// This is now the engagement *setup* step — it CREATES the row if it doesn't
// exist yet (Postgres generates the UUID and we return it), or UPDATES it if it
// does. So Airtable never has to know the Supabase UUID up front.
//
// Identity / dedupe (in priority order):
//   1. engagement_id  — if given, target that exact row (must exist → else 404).
//                       Back-compat path for Ecton's seeded UUID.
//   2. airtable_base  — the Airtable BASE id (app...). THE natural upsert key:
//                       one base = one engagement in our model, so a new project
//                       (new base) creates a new row, and a re-click on the same
//                       base finds the same row. If none matches, we CREATE one.
//   3. airtable_record_id — LEGACY fallback (the engagement row's Airtable
//                       record id, stored in engagements.airtable_record_id —
//                       renamed in 0014 from the misnamed airtable_base_id).
//                       Used ONLY when NO airtable_base was sent (truly old
//                       callers). When a base id IS present it is the sole
//                       identity — we never fall back to the record id —
//                       because the master-script sends the SAME engagement
//                       record id for every base, so matching on it cross-matched
//                       unrelated projects (Kota's base → Gallium's row). See
//                       ADR-014 addendum.
//
// Contract (ADR-012, revised):
//   POST body: {
//     // identity — provide at least one:
//     engagement_id?,         // existing UUID (update-only)
//     airtable_base?,         // Airtable base id (app...) — primary upsert key
//     airtable_record_id?,    // Airtable record id — legacy upsert key
//     // required to CREATE a new engagement (ignored on update unless provided):
//     client_name?, audit_type?, attest_start?, attest_end?,
//     status?,                // defaults to "active" on create
//     // Drive IDs (required):
//     google_drive_id, evidence_folder_id,
//     trigger_source?
//   }
//   header: x-audit-secret
//
// Drive columns came from migration 0003; airtable_record_id exists since 0001
// (renamed from airtable_base_id in 0014).
import { getServiceClient } from "../_shared/supabase-client.ts";
import { completeJobRun, failJobRun, startJobRun } from "../_shared/job-run.ts";
import { checkSharedSecret } from "../_shared/auth.ts";
import { generateApiKey, hashApiKey } from "../_shared/engagement-key.ts";
import { type AirtablePatchResult, patchAirtableRecord } from "../_shared/airtable.ts";

const FUNCTION_NAME = "register-engagement";

interface RequestPayload {
  engagement_id?: string;
  airtable_record_id?: string;
  client_name?: string;
  audit_type?: string;
  attest_start?: string;
  attest_end?: string;
  status?: string;
  google_drive_id: string;
  evidence_folder_id: string;
  airtable_base?: string; // real Airtable base id (app...) for write-back
  airtable_engagement_table?: string; // engagement table id/name, for the app_id write-back
  trigger_source?: string;
}

interface EngagementRow {
  id: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const authErr = checkSharedSecret(req);
  if (authErr) return authErr;

  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let payload: RequestPayload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  // Drive IDs are always required.
  for (const f of ["google_drive_id", "evidence_folder_id"] as const) {
    if (typeof payload[f] !== "string" || !payload[f]) {
      return jsonResponse({ error: `Missing or invalid '${f}'` }, 400);
    }
  }
  // Need at least one identity key. The natural upsert key is the Airtable BASE
  // id (one base = one engagement in our model); airtable_record_id is still
  // accepted for backward compatibility.
  if (!payload.engagement_id && !payload.airtable_base && !payload.airtable_record_id) {
    return jsonResponse(
      {
        error:
          "Provide 'engagement_id', 'airtable_base', or 'airtable_record_id' to identify the engagement",
      },
      400,
    );
  }

  const supabase = getServiceClient();

  // ── Resolve the target row (or decide to create one). ──────────────────────
  //
  // Identity is the Airtable BASE id (app...): one base = one engagement, so the
  // base id is the stable, unique key. The OLD key was the record id (in the
  // column once misnamed airtable_base_id, renamed to airtable_record_id in 0014)
  // — which stores the engagement ROW's RECORD id (rec...). That was
  // fragile: every base's engagement is "the first row", so a new project could
  // present a record id that matched an existing row and UPDATE/OVERRIDE it
  // instead of creating a new engagement (and then no key was minted). We now
  // match on airtable_base first, falling back to the legacy record-id key so
  // engagements registered before this change (whose airtable_base may still be
  // NULL) still resolve — the update path backfills airtable_base.
  let existing: EngagementRow | null = null;
  if (payload.engagement_id) {
    const { data, error } = await supabase
      .from("engagements")
      .select("id")
      .eq("id", payload.engagement_id)
      .maybeSingle();
    if (error) return jsonResponse({ error: error.message }, 500);
    // Explicit UUID that doesn't exist is an error — don't silently create with
    // a caller-chosen id (it may be a typo).
    if (!data) {
      return jsonResponse({ error: `Engagement ${payload.engagement_id} not found` }, 404);
    }
    existing = data;
  } else {
    // Primary: match on the Airtable base id (app...).
    if (payload.airtable_base) {
      const { data, error } = await supabase
        .from("engagements")
        .select("id")
        .eq("airtable_base", payload.airtable_base)
        .maybeSingle();
      if (error) return jsonResponse({ error: error.message }, 500);
      existing = data;
    }
    // Legacy fallback: match on the engagement record id (pre-airtable_base
    // backfill) — ONLY when no airtable_base was sent. The app id (airtable_base)
    // is the authoritative identity: one base = one engagement. We must NOT fall
    // back to the record id when a base id is present, because the Airtable
    // master-script sends the SAME engagement record id for every base (a single
    // hardcoded recordId), so matching on it cross-matches unrelated projects
    // (Kota's base resolving to Gallium's row, etc.). With a base id in hand, a
    // no-match means a genuinely new base → create. The legacy path now serves
    // only truly old callers that don't send airtable_base at all.
    if (!existing && payload.airtable_record_id && !payload.airtable_base) {
      const { data, error } = await supabase
        .from("engagements")
        .select("id")
        .eq("airtable_record_id", payload.airtable_record_id)
        .maybeSingle();
      if (error) return jsonResponse({ error: error.message }, 500);
      existing = data;
    }
    // null → we'll create below
  }

  // If creating, the four NOT NULL columns must be present.
  if (!existing) {
    const required = ["client_name", "audit_type", "attest_start", "attest_end"] as const;
    const missing = required.filter((f) => typeof payload[f] !== "string" || !payload[f]);
    if (missing.length > 0) {
      return jsonResponse(
        {
          error:
            `Creating a new engagement requires: ${missing.join(", ")}. ` +
            `(No existing engagement matched airtable_base '${payload.airtable_base}' ` +
            `or airtable_record_id '${payload.airtable_record_id}'.)`,
        },
        400,
      );
    }
  }

  const job = await startJobRun({
    function_name: FUNCTION_NAME,
    trigger_source: payload.trigger_source ?? "airtable",
    payload: payload as unknown as Record<string, unknown>,
    engagement_id: existing?.id ?? null,
  }).catch(() => null);
  if (!job) return jsonResponse({ error: "Failed to start job_run" }, 500);

  try {
    let engagementId: string;
    let created: boolean;
    // Plaintext per-engagement key — minted ONLY on create, returned ONCE below,
    // then unrecoverable (we store just its hash). Null on the update path.
    let apiKey: string | null = null;

    if (existing) {
      // ── UPDATE: refresh Drive IDs, plus any creation fields that were sent. ──
      const update: Record<string, unknown> = {
        google_drive_id: payload.google_drive_id,
        evidence_folder_id: payload.evidence_folder_id,
        updated_at: new Date().toISOString(),
      };
      for (const f of ["client_name", "audit_type", "attest_start", "attest_end", "status"] as const) {
        if (typeof payload[f] === "string" && payload[f]) update[f] = payload[f];
      }
      if (typeof payload.airtable_base === "string" && payload.airtable_base) {
        update.airtable_base = payload.airtable_base;
      }
      const { error } = await supabase
        .from("engagements")
        .update(update)
        .eq("id", existing.id);
      if (error) throw new Error(`Failed to update engagement: ${error.message}`);
      engagementId = existing.id;
      created = false;
    } else {
      // ── CREATE: Postgres generates the UUID; we return it to Airtable. ──────
      // Mint this engagement's API key now (ADR-011). Store only its hash; the
      // plaintext goes back to Airtable once in the response and is then gone.
      apiKey = generateApiKey();
      const apiKeyHash = await hashApiKey(apiKey);
      const { data, error } = await supabase
        .from("engagements")
        .insert({
          client_name: payload.client_name,
          audit_type: payload.audit_type,
          attest_start: payload.attest_start,
          attest_end: payload.attest_end,
          status: payload.status ?? "active",
          airtable_record_id: payload.airtable_record_id,
          airtable_base: payload.airtable_base ?? null,
          google_drive_id: payload.google_drive_id,
          evidence_folder_id: payload.evidence_folder_id,
          api_key_hash: apiKeyHash,
          api_key_set_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (error) throw new Error(`Failed to create engagement: ${error.message}`);
      engagementId = data.id;
      created = true;
    }

    // Mirror the real Airtable base id (app...) back into the engagement row's
    // "app_id" field, so it's visible in Airtable and confirms Supabase captured
    // it. Best-effort: never fails the registration. Requires the base id (sent by
    // master-script as base.id), the engagement record id, and the engagement
    // table id — if any is missing we skip (the field stays empty, which is itself
    // a signal that master-script isn't sending the base id yet).
    let appIdSync: AirtablePatchResult = { attempted: false, ok: true };
    if (payload.airtable_base && payload.airtable_engagement_table) {
      appIdSync = await patchAirtableRecord({
        baseId: payload.airtable_base,
        tableId: payload.airtable_engagement_table,
        recordId: payload.airtable_record_id ?? null,
        fields: { app_id: payload.airtable_base },
      });
      if (appIdSync.attempted && !appIdSync.ok) {
        console.error(`app_id write-back failed: ${appIdSync.error}`);
      }
    }

    const result = {
      success: true,
      created, // true = new row, false = updated existing
      app_id_sync: appIdSync, // confirms whether the app_id write-back landed
      engagement_id: engagementId, // Airtable should store this back on the row
      // Returned ONCE, only on create. Airtable must save this to a sensitive
      // field — it's this engagement's auth key for every per-control call and
      // cannot be recovered later. Absent on the update path.
      ...(apiKey ? { api_key: apiKey } : {}),
      google_drive_id: payload.google_drive_id,
      evidence_folder_id: payload.evidence_folder_id,
      job_run_id: job.id,
    };
    // Never persist the plaintext key to job_runs — redact it for the record.
    const { api_key: _redacted, ...jobResult } = result as Record<string, unknown>;
    await completeJobRun({ handle: job, result: { ...jobResult, api_key_issued: created } });
    return jsonResponse(result);
  } catch (err) {
    const e = err as Error;
    await failJobRun({ handle: job, error_message: e.message, error_stack: e.stack });
    return jsonResponse({ error: e.message, job_run_id: job.id }, 500);
  }
});
