// sweep-stuck-jobs — the stuck-job WATCHMAN (stalled-job detection + recovery).
//
// Problem it solves: a pipeline step (sync-control-evidence, run-audit, rerun-audit,
// pace-controls, …) opens a job_runs row in status='running' and is expected to flip
// it to success/failed before returning. A hard edge wall-clock kill runs NO cleanup,
// so the row is orphaned in 'running' forever:
//   - the control's "ClearCheck 💬" progress bar freezes mid-count,
//   - run-audit is never chained (sync only triggers it on success),
//   - the auditor gets no signal of what happened or what to do.
// The killed worker can't self-report — so something OUTSIDE it must. That's this.
//
// What it does, each run (intended cadence: every few minutes via pg_cron, see
// migration 0013):
//   1. Find job_runs still 'running' older than STUCK_THRESHOLD_MIN.
//   2. Mark each 'failed' with a clear "swept" reason (so the row stops lying).
//   3. For control-owning functions (sync-control-evidence / rerun-audit), post a
//      recovery message to the control's 💬 telling the auditor to press Re-run
//      (re-running is safe — ingest dedupes by file hash and resumes).
// It is itself a job_runs row, and it never sweeps its own function_name.
//
// Auth: this is a SYSTEM / cross-engagement operation (it sweeps every engagement's
// jobs), so — like register-engagement — it uses the shared AUDIT_SHARED_SECRET, NOT
// a per-engagement key. The cron caller (pg_net) sends it in the x-audit-secret header.

import { getServiceClient } from "../_shared/supabase-client.ts";
import { checkSharedSecret } from "../_shared/auth.ts";
import { completeJobRun, failJobRun, startJobRun } from "../_shared/job-run.ts";
import { patchAirtableRecord } from "../_shared/airtable.ts";
import {
  CONTROL_RECOVERABLE_FUNCTIONS,
  type JobRunRow,
  planSweep,
  recoveryStatus,
  sweptErrorMessage,
} from "./sweep-logic.ts";

const FUNCTION_NAME = "sweep-stuck-jobs";

// Airtable controls table id — stable across base clones (same constant
// sync-control-evidence uses to write the 💬).
const AIRTABLE_CONTROLS_TABLE_ID = "tblZrxDzOKd9FJkbC";
const CONTROL_STATUS_FIELD = "ClearCheck 💬";

// A 'running' row older than this is declared dead. One edge invocation can't
// outlive its wall-clock budget (~150s), and sync self-chains as SEPARATE job_runs,
// so no legitimate single row stays 'running' for minutes. Default 8m leaves wide
// headroom against false positives while still catching true stalls quickly.
const STUCK_THRESHOLD_MIN = Math.max(2, Number(Deno.env.get("STUCK_THRESHOLD_MIN") ?? "8"));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authErr = checkSharedSecret(req);
  if (authErr) return authErr;

  const supabase = getServiceClient();
  const nowMs = Date.now();
  // SQL pre-filter (indexed on status) — narrow to running rows already past the
  // threshold; planSweep re-checks age + self-exclusion as defense in depth.
  const cutoffIso = new Date(nowMs - STUCK_THRESHOLD_MIN * 60_000).toISOString();

  const job = await startJobRun({
    function_name: FUNCTION_NAME,
    trigger_source: "cron",
    payload: { threshold_min: STUCK_THRESHOLD_MIN },
  });

  try {
    const { data, error } = await supabase
      .from("job_runs")
      .select("id, function_name, status, started_at, engagement_id, payload")
      .eq("status", "running")
      .lt("started_at", cutoffIso)
      .neq("function_name", FUNCTION_NAME)
      .order("started_at", { ascending: true })
      .limit(200);
    if (error) throw new Error(`job_runs scan failed: ${error.message}`);

    const decisions = planSweep({
      rows: (data ?? []) as JobRunRow[],
      nowMs,
      thresholdMinutes: STUCK_THRESHOLD_MIN,
      selfFunctionName: FUNCTION_NAME,
    });

    // Resolve the Airtable target (base + record) once per engagement, lazily, so
    // we can post the recovery 💬. Cache engagement → airtable_base across rows.
    const baseCache = new Map<string, string | null>();
    const getAirtableBase = async (engagementId: string): Promise<string | null> => {
      if (baseCache.has(engagementId)) return baseCache.get(engagementId)!;
      const { data: eng } = await supabase
        .from("engagements")
        .select("airtable_base")
        .eq("id", engagementId)
        .maybeSingle();
      const base = (eng?.airtable_base as string | null) ?? null;
      baseCache.set(engagementId, base);
      return base;
    };

    let sweptCount = 0;
    let notifiedCount = 0;
    const sweptIds: string[] = [];

    for (const d of decisions) {
      // 1. Stop the row from lying: mark it failed with a clear reason.
      const { error: updErr } = await supabase
        .from("job_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_message: sweptErrorMessage(d.function_name, d.stuck_minutes),
        })
        .eq("id", d.id)
        .eq("status", "running"); // guard: skip if it resolved between scan and now
      if (updErr) {
        console.error(`sweep: failed to mark ${d.id} failed: ${updErr.message}`);
        continue;
      }
      sweptCount++;
      sweptIds.push(d.id);

      // 2. Surface it to the auditor (only for control-owning, recoverable funcs).
      if (!CONTROL_RECOVERABLE_FUNCTIONS.includes(d.function_name)) continue;
      if (!d.control_uuid || !d.engagement_id) continue;

      const { data: control } = await supabase
        .from("controls")
        .select("airtable_record_id")
        .eq("id", d.control_uuid)
        .maybeSingle();
      const recordId = (control?.airtable_record_id as string | null) ?? null;
      if (!recordId) continue;

      const base = await getAirtableBase(d.engagement_id);
      const res = await patchAirtableRecord({
        baseId: base,
        tableId: AIRTABLE_CONTROLS_TABLE_ID,
        recordId,
        fields: { [CONTROL_STATUS_FIELD]: recoveryStatus(d.function_name, d.stuck_minutes) },
      });
      if (res.attempted && !res.ok) {
        console.error(`sweep: 💬 write failed for control ${d.control_uuid}: ${res.error}`);
      } else if (res.ok && res.attempted) {
        notifiedCount++;
      }
    }

    const result = {
      scanned: data?.length ?? 0,
      swept: sweptCount,
      notified: notifiedCount,
      threshold_min: STUCK_THRESHOLD_MIN,
      swept_ids: sweptIds,
    };
    await completeJobRun({ handle: job, result });
    return jsonResponse({ success: true, ...result });
  } catch (err) {
    const e = err as Error;
    await failJobRun({ handle: job, error_message: e.message, error_stack: e.stack });
    return jsonResponse({ error: e.message }, 500);
  }
});
