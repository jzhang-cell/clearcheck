// run-audit — HTTP entry for auditing ONE control. The actual pipeline (Opus
// judgment → Sonnet workpaper → DB writes → Airtable write-back) lives in
// _shared/audit-pipeline.ts (ADR-015) so the audit-worker queue consumer can
// run the identical code without an HTTP hop.
//
// In production this entry is for manual/debug calls and smoke tests — the
// normal path is sync-control-evidence enqueueing into audit_queue and
// audit-worker draining it. The HTTP contract is unchanged: per-engagement key
// auth, 202 ack with job_run_id in prod (background execution), full inline
// result locally (tests/hand calls).

import { resolveEngagementByKey } from "../_shared/auth.ts";
import { startJobRun } from "../_shared/job-run.ts";
import { loadControlForAudit, runAuditPipeline } from "../_shared/audit-pipeline.ts";

const FUNCTION_NAME = "run-audit";

interface RequestPayload {
  control_uuid: string; // controls.id (UUID); the display code is controls.control_id
  trigger_source?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  // Per-engagement key auth — resolves which engagement this caller owns.
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

  if (typeof payload.control_uuid !== "string" || !payload.control_uuid) {
    return jsonResponse({ error: "Missing or invalid 'control_uuid'" }, 400);
  }
  const triggerSource = payload.trigger_source ?? "manual";

  // Pre-flight (scoped load + refinement checks) — shared with the pipeline.
  const preflight = await loadControlForAudit(engagementId, payload.control_uuid);
  if (!preflight.ok) return jsonResponse({ error: preflight.error }, preflight.status);
  const control = preflight.control;

  // Parent job_run — opened here (not in the pipeline) so the 202 ack below can
  // carry job_run_id, preserving the pre-extraction contract.
  let job;
  try {
    job = await startJobRun({
      function_name: FUNCTION_NAME,
      trigger_source: triggerSource,
      payload: payload as unknown as Record<string, unknown>,
      engagement_id: control.engagement_id,
    });
  } catch (err) {
    return jsonResponse(
      { error: `Failed to start job_run: ${(err as Error).message}` },
      500,
    );
  }

  const run = () =>
    runAuditPipeline({
      engagementId,
      controlUuid: control.id,
      triggerSource,
      control,
      job,
    });

  // Dispatch: in production (Supabase Edge runtime) run in the background and
  // ack immediately so any script caller returns well under its ~30s cap. The
  // pipeline handles its own errors (marks audit_runs failed + failJobRun) and
  // writes its own results to Airtable. Locally (no EdgeRuntime), await inline
  // and return the full result, preserving the old synchronous contract.
  const edgeRuntime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(run().catch((e) => console.error(`runAuditPipeline crashed: ${e}`)));
    return jsonResponse(
      {
        accepted: true,
        status: "processing",
        control_uuid: control.id,
        engagement_id: control.engagement_id,
        job_run_id: job.id,
        note: "Audit runs in the background; results are written to Airtable when complete.",
      },
      202,
    );
  }
  const result = await run();
  return jsonResponse(result.body, result.status);
});
