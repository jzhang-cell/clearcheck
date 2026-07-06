// register-control — UPSERTS a control and its TSC links for an engagement.
// Called once per control at the start of the per-control Airtable script (step 0),
// before sync → refine → audit. This is the runtime equivalent of what seed.sql does
// for test data — it's the ONLY place controls are created for real engagements.
//
// Auth: per-engagement key (x-audit-secret). The key identifies the engagement —
// no engagement_id is needed in the body; it's derived from the key.
//
// Naming (matches the DB columns, consistent across all functions):
//   control_id   = the human-readable code, e.g. "CC.01.02" (DB: controls.control_id)
//   control_uuid = the row's UUID primary key            (DB: controls.id)
//
// Dedupe key: unique(engagement_id, control_id) — re-clicking [Run V3] on the
// same control updates it instead of creating a duplicate.
//
// TSC links: pass tsc_uuids (Supabase UUIDs already stored in Airtable). Existing
// links are REPLACED (delete + insert) so removing a TSC from Airtable takes effect
// on the next run. If tsc_uuids is absent or empty, existing links are left untouched.
//
// Contract:
//   POST body: {
//     control_id: string,              // display code, e.g. "CC.01.02" (required)
//     company_control?: string,
//     control_description?: string,
//     expected_procedures?: string,
//     tsc_uuids?: string[],            // Supabase tscs.id UUIDs — replaces prior links
//     airtable_record_id?: string,
//     trigger_source?: string,
//   }
//   header: x-audit-secret  (per-engagement key — identifies engagement)
//   response: { success, created, control_uuid, engagement_id, tsc_uuids_linked, job_run_id }
import { withEngagementScope } from "../_shared/scoped-db.ts";
import { completeJobRun, failJobRun, startJobRun } from "../_shared/job-run.ts";
import { resolveEngagementByKey } from "../_shared/auth.ts";

const FUNCTION_NAME = "register-control";

interface RequestPayload {
  control_id: string; // the display code, e.g. "CC.01.02"
  company_control?: string;
  control_description?: string;
  expected_procedures?: string;
  tsc_uuids?: string[];
  airtable_record_id?: string;
  trigger_source?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  // Per-engagement key auth — also resolves which engagement this is for.
  const authResult = await resolveEngagementByKey(req);
  if ("error" in authResult) return authResult.error;
  const { engagementId } = authResult;

  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let payload: RequestPayload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (typeof payload.control_id !== "string" || !payload.control_id) {
    return jsonResponse({ error: "Missing required field: control_id" }, 400);
  }

  const job = await startJobRun({
    function_name: FUNCTION_NAME,
    trigger_source: payload.trigger_source ?? "airtable",
    payload: payload as unknown as Record<string, unknown>,
    engagement_id: engagementId,
  }).catch(() => null);
  if (!job) return jsonResponse({ error: "Failed to start job_run" }, 500);

  try {
    const tscUuids = Array.isArray(payload.tsc_uuids)
      ? payload.tsc_uuids.filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];

    // All client-data writes in one scoped transaction:
    //   1. Upsert the control (RLS WITH CHECK enforces engagement match).
    //   2. Replace TSC links if provided; else read back existing ones.
    // The engagement_scoped role can't touch another engagement's rows — isolation
    // is enforced at the DB, not just in code.
    const { controlUuid, created, tscUuidsLinked } = await withEngagementScope(
      engagementId,
      async (tx) => {
        // ── 1. Upsert the control row. ──────────────────────────────────────
        const fields: Record<string, unknown> = {
          engagement_id: engagementId,
          control_id: payload.control_id,
          updated_at: new Date().toISOString(),
        };
        if (typeof payload.company_control === "string") fields.company_control = payload.company_control;
        if (typeof payload.control_description === "string") fields.control_description = payload.control_description;
        if (typeof payload.expected_procedures === "string") fields.expected_procedures = payload.expected_procedures;
        if (typeof payload.airtable_record_id === "string") fields.airtable_record_id = payload.airtable_record_id;

        // porsager/postgres: spread the fields object via sql(fields) into an
        // INSERT … ON CONFLICT DO UPDATE. We build the column list + values
        // explicitly so the upsert stays readable and the conflict target is clear.
        const cols = Object.keys(fields);
        const vals = cols.map((c) => fields[c]);
        // Raw tagged template for the upsert; conflict target uses raw identifiers.
        const [upserted] = await tx<{ id: string; created_at: string; updated_at: string }[]>`
          insert into controls ${tx(fields, ...cols as [string, ...string[]])}
          on conflict (engagement_id, control_id)
          do update set ${tx(
            Object.fromEntries(
              cols.filter((c) => c !== "engagement_id" && c !== "control_id")
                .map((c) => [c, fields[c]]),
            ),
          )}
          returning id, created_at, updated_at
        `;

        const controlUuid = upserted.id;
        const created = upserted.created_at === upserted.updated_at;

        // ── 2. Replace TSC links (if provided) or read existing ones. ───────
        let tscUuidsLinked: string[] = [];
        if (tscUuids.length > 0) {
          await tx`delete from control_tscs where control_id = ${controlUuid}`;
          // The trg_control_tscs_engagement trigger auto-derives engagement_id from
          // the controls parent row, so we omit it here to keep the insert clean.
          await tx`
            insert into control_tscs (control_id, tsc_id)
            select ${controlUuid}, unnest(${tscUuids}::uuid[])
          `;
          tscUuidsLinked = tscUuids;
        } else {
          const rows = await tx<{ tsc_id: string }[]>`
            select tsc_id from control_tscs where control_id = ${controlUuid}
          `;
          tscUuidsLinked = rows.map((r) => r.tsc_id);
        }

        return { controlUuid, created, tscUuidsLinked };
      },
    );

    const result = {
      success: true,
      created,
      control_uuid: controlUuid,
      engagement_id: engagementId,
      tsc_uuids_linked: tscUuidsLinked,
      job_run_id: job.id,
    };
    await completeJobRun({ handle: job, result: result as unknown as Record<string, unknown> });
    return jsonResponse(result);
  } catch (err) {
    const e = err as Error;
    await failJobRun({ handle: job, error_message: e.message, error_stack: e.stack });
    return jsonResponse({ error: e.message, job_run_id: job.id }, 500);
  }
});
