import { withEngagementScope } from "../_shared/scoped-db.ts";
import type { Sql } from "../_shared/scoped-db.ts";
import { callClaude } from "../_shared/claude-client.ts";
import { loadActivePrompt } from "../_shared/load-prompt.ts";
import { renderTemplate } from "../_shared/render-template.ts";
import { completeJobRun, failJobRun, startJobRun } from "../_shared/job-run.ts";
import { assertNotTruncated } from "../_shared/claude-parse.ts";
import { resolveEngagementByKey } from "../_shared/auth.ts";
import { patchAirtableRecord } from "../_shared/airtable.ts";
import { parseRefinedExpectedProcedure } from "./refine-logic.ts";

const FUNCTION_NAME = "refine-control";
const PROMPT_KEY = "control_refiner";
const AIRTABLE_TABLE_ID = "tblZrxDzOKd9FJkbC";

interface RequestPayload {
  control_uuid: string; // controls.id (UUID); the display code is controls.control_id
  trigger_source?: string;
}

interface ControlRow {
  id: string;
  engagement_id: string;
  control_id: string;
  control_description: string | null;
  expected_procedures: string | null;
  airtable_record_id: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// All three loaders run on the engagement-scoped tx — RLS guarantees they can
// only see this engagement's rows (controls, control_tscs, engagements). A
// control belonging to another engagement simply returns no rows → 404.
async function loadControl(tx: Sql, controlId: string): Promise<ControlRow> {
  const rows = await tx<ControlRow[]>`
    select id, engagement_id, control_id, control_description,
           expected_procedures, airtable_record_id
    from controls
    where id = ${controlId}
  `;
  const data = rows[0];
  if (!data) throw new Error(`Control ${controlId} not found`);
  if (!data.control_description) {
    throw new Error(`Control ${controlId} has empty control_description`);
  }
  if (!data.expected_procedures) {
    throw new Error(`Control ${controlId} has empty expected_procedures`);
  }
  return data;
}

async function loadTscString(tx: Sql, controlId: string): Promise<string> {
  const rows = await tx<{ tsc_code: string; description: string }[]>`
    select t.tsc_code, t.description
    from control_tscs ct
    join tscs t on t.id = ct.tsc_id
    where ct.control_id = ${controlId}
    order by t.tsc_code
  `;
  if (rows.length === 0) {
    throw new Error(`Control ${controlId} has no linked TSCs`);
  }
  return rows.map((t) => `${t.tsc_code}: ${t.description}`).join("\n");
}

async function loadAirtableBaseId(tx: Sql, engagementId: string): Promise<string | null> {
  // `airtable_base` (migration 0009) holds the real base id (app...). The separate
  // `airtable_record_id` column (renamed in 0014 from the misnamed airtable_base_id)
  // stores a rec... id; reading THAT here made every refine write-back silently
  // no-op (V3_Refined_* stayed empty).
  // Mirrors run-audit / sync-control-evidence, which already read `airtable_base`.
  const rows = await tx<{ airtable_base: string | null }[]>`
    select airtable_base from engagements where id = ${engagementId}
  `;
  return rows[0]?.airtable_base ?? null;
}

Deno.serve(async (req: Request) => {
  // Per-engagement key auth — resolves which engagement this caller owns.
  const authResult = await resolveEngagementByKey(req);
  if ("error" in authResult) return authResult.error;
  const { engagementId } = authResult;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let payload: RequestPayload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (typeof payload.control_uuid !== "string" || !payload.control_uuid) {
    return jsonResponse({ error: "Missing or invalid 'control_uuid'" }, 400);
  }

  // Load control first so the job_run is scoped to the right engagement. The
  // read runs under the engagement stamp, so a control owned by a different
  // engagement is invisible at the DB → "not found" (RLS, not just a code check).
  let control: ControlRow;
  try {
    control = await withEngagementScope(
      engagementId,
      (tx) => loadControl(tx, payload.control_uuid),
    );
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 404);
  }
  // Defense-in-depth: RLS already guarantees this, but assert the invariant.
  if (control.engagement_id !== engagementId) {
    return jsonResponse({ error: "Unauthorized" }, 403);
  }

  let job;
  try {
    job = await startJobRun({
      function_name: FUNCTION_NAME,
      trigger_source: payload.trigger_source ?? "manual",
      payload: payload as unknown as Record<string, unknown>,
      engagement_id: control.engagement_id,
    });
  } catch (err) {
    console.error(`startJobRun failed: ${(err as Error).message}`);
    return jsonResponse({ error: `Internal: ${(err as Error).message}` }, 500);
  }

  try {
    // prompt = system table (service_role); tscs = client data (scoped). Run both
    // concurrently. The scoped read holds its tx only for the TSC query.
    const [prompt, tscsString] = await Promise.all([
      loadActivePrompt(PROMPT_KEY),
      withEngagementScope(engagementId, (tx) => loadTscString(tx, control.id)),
    ]);

    const userText = renderTemplate(prompt.user_prompt_template, {
      control_description: control.control_description!,
      expected_procedures: control.expected_procedures!,
      tscs: tscsString,
    });

    const claude = await callClaude({
      model: prompt.model,
      system: prompt.system_prompt,
      user: userText,
      max_tokens: prompt.max_tokens,
    });

    assertNotTruncated({
      stop_reason: claude.stop_reason,
      model: prompt.model,
      max_tokens: prompt.max_tokens,
      context: `prompt_key=${prompt.prompt_key}`,
    });
    const refined = parseRefinedExpectedProcedure(claude.text);

    // Persist only the expected-procedure refinement. Clear the legacy refined
    // description so old AI wording can never be mistaken for the source control.
    const airtableBaseId = await withEngagementScope(engagementId, async (tx) => {
      await tx`
        update controls set
          refined_control_description = null,
          refined_expected_procedure = ${refined.Refined_Expected_Procedure},
          refinement_status = 'refined',
          refined_at = now()
        where id = ${control.id}
      `;
      return await loadAirtableBaseId(tx, control.engagement_id);
    });

    // Best-effort Airtable mirror. The legacy refined-description field is
    // cleared so the original Control Description remains the only description.
    const airtableSync = await patchAirtableRecord({
      baseId: airtableBaseId,
      tableId: AIRTABLE_TABLE_ID,
      recordId: control.airtable_record_id,
      fields: {
        V3_Refined__Control_Description: null,
        V3_Refined_Expected_Procedure: refined.Refined_Expected_Procedure,
      },
    });
    if (airtableSync.attempted && !airtableSync.ok) {
      console.error(`Airtable write-back failed: ${airtableSync.error}`);
    }

    await completeJobRun({
      handle: job,
      result: {
        prompt_id: prompt.prompt_id,
        prompt_version: prompt.version,
        model: prompt.model,
        input_tokens: claude.input_tokens,
        output_tokens: claude.output_tokens,
        stop_reason: claude.stop_reason,
        refined_expected_procedure_length: refined.Refined_Expected_Procedure.length,
        control_description_source: "original",
        airtable_sync: airtableSync,
      },
    });

    return jsonResponse({
      success: true,
      control_uuid: control.id,
      job_run_id: job.id,
      refined_expected_procedure: refined.Refined_Expected_Procedure,
      control_description_source: "original",
      tokens: { input: claude.input_tokens, output: claude.output_tokens },
      airtable_sync: airtableSync,
    });
  } catch (err) {
    const e = err as Error;
    await failJobRun({
      handle: job,
      error_message: e.message,
      error_stack: e.stack,
    });
    return jsonResponse({ error: e.message, job_run_id: job.id }, 500);
  }
});
