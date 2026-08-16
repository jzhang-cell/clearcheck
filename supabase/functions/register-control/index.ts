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
//     use_procedures_as_provided?: boolean, // re-run only: skip AI refinement
//     tsc_uuids?: string[],            // Supabase tscs.id UUIDs — replaces prior links
//     airtable_record_id?: string,
//     trigger_source?: string,
//   }
//   header: x-audit-secret  (per-engagement key — identifies engagement)
//   response: { success, created, control_uuid, engagement_id, tsc_uuids_linked, job_run_id }
import { withEngagementScope } from "../_shared/scoped-db.ts";
import { completeJobRun, failJobRun, startJobRun } from "../_shared/job-run.ts";
import { resolveEngagementByKey } from "../_shared/auth.ts";
import { normalizeControlCode } from "../_shared/control-code.ts";
import { buildControlUpsertFields } from "./register-logic.ts";

const FUNCTION_NAME = "register-control";

interface RequestPayload {
  control_id: string; // the display code, e.g. "CC.01.02"
  company_control?: string;
  control_description?: string;
  expected_procedures?: string;
  use_procedures_as_provided?: boolean;
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

  if (typeof payload.control_id !== "string") {
    return jsonResponse({ error: "Missing required field: control_id" }, 400);
  }
  const rawControlId = payload.control_id;
  const controlId = normalizeControlCode(rawControlId);
  if (!controlId) return jsonResponse({ error: "Missing required field: control_id" }, 400);
  if (
    payload.use_procedures_as_provided !== undefined &&
    typeof payload.use_procedures_as_provided !== "boolean"
  ) {
    return jsonResponse({ error: "'use_procedures_as_provided' must be a boolean" }, 400);
  }
  if (
    payload.use_procedures_as_provided === true &&
    (typeof payload.control_description !== "string" || !payload.control_description.trim() ||
      typeof payload.expected_procedures !== "string" || !payload.expected_procedures.trim())
  ) {
    return jsonResponse(
      {
        error:
          "'use_procedures_as_provided' requires non-empty 'control_description' and 'expected_procedures'",
      },
      400,
    );
  }

  const job = await startJobRun({
    function_name: FUNCTION_NAME,
    trigger_source: payload.trigger_source ?? "airtable",
    payload: {
      ...payload,
      control_id: controlId,
      control_id_was_normalized: controlId !== rawControlId,
    } as unknown as Record<string, unknown>,
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
        const fields = buildControlUpsertFields({
          engagementId,
          controlId,
          updatedAt: new Date().toISOString(),
          companyControl: payload.company_control,
          controlDescription: payload.control_description,
          expectedProcedures: payload.expected_procedures,
          useProceduresAsProvided: payload.use_procedures_as_provided === true,
          airtableRecordId: payload.airtable_record_id,
        });

        // porsager/postgres: spread the fields object via sql(fields) into an
        // INSERT … ON CONFLICT DO UPDATE. We build the column list + values
        // explicitly so the upsert stays readable and the conflict target is clear.
        const cols = Object.keys(fields);
        let upserted!: { id: string; created_at: string; updated_at: string };
        let created = false;

        // Preserve the existing control UUID when an imported Airtable code only
        // differs by invisible characters. Updating that row in place keeps its
        // evidence links and audit history attached to the same control.
        let rawMatch: { id: string } | undefined;
        if (rawControlId !== controlId) {
          [rawMatch] = await tx<{ id: string }[]>`
            select id from controls
            where engagement_id = ${engagementId} and control_id = ${rawControlId}
            limit 1
          `;
        }
        const [normalizedMatch] = await tx<{ id: string }[]>`
          select id from controls
          where engagement_id = ${engagementId} and control_id = ${controlId}
          limit 1
        `;

        if (rawMatch && !normalizedMatch) {
          const updateFields = Object.fromEntries(
            cols.filter((c) => c !== "engagement_id").map((c) => [c, fields[c]]),
          );
          const updateCols = Object.keys(updateFields);
          [upserted] = await tx<
            { id: string; created_at: string; updated_at: string }[]
          >`
            update controls
            set ${tx(updateFields, ...updateCols as [string, ...string[]])}
            where id = ${rawMatch.id}
            returning id, created_at, updated_at
          `;
        } else {
          // Raw tagged template for the upsert; conflict target uses raw identifiers.
          [upserted] = await tx<
            { id: string; created_at: string; updated_at: string }[]
          >`
            insert into controls ${tx(fields, ...cols as [string, ...string[]])}
            on conflict (engagement_id, control_id)
            do update set ${
            tx(
              Object.fromEntries(
                cols.filter((c) => c !== "engagement_id" && c !== "control_id")
                  .map((c) => [c, fields[c]]),
              ),
            )
          }
            returning id, created_at, updated_at
          `;
          created = upserted.created_at === upserted.updated_at;
        }

        const controlUuid = upserted.id;

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
