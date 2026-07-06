// sweep-logic.ts — pure decision logic for the stuck-job watchman.
//
// Separated from index.ts (like pace-logic.ts) so the "which jobs are stuck and
// what do we tell the user" decision is unit-testable with no DB/HTTP.
//
// Background: every pipeline step opens a job_runs row in status='running' and is
// expected to flip it to 'success'/'failed' before it returns. But a hard
// wall-clock kill (edge timeout) runs NO cleanup code, so the row is orphaned in
// 'running' forever — the failure goes silent. This module decides which running
// rows are old enough to be declared dead, and crafts the recovery message.

// A job_runs row, narrowed to the columns the sweep needs.
export interface JobRunRow {
  id: string;
  function_name: string;
  status: string;
  started_at: string; // ISO timestamp
  engagement_id: string | null;
  payload: Record<string, unknown> | null;
}

// One row the sweep has decided is dead.
export interface SweepDecision {
  id: string;
  function_name: string;
  engagement_id: string | null;
  // control's UUID if the payload carried one — lets index.ts resolve the
  // Airtable row to post a recovery 💬 to. Null for system jobs (no 💬 to write).
  control_uuid: string | null;
  stuck_minutes: number;
}

// Functions that own a control's "ClearCheck 💬" and whose stall the auditor can
// recover from by pressing Re-run. For these we both fail the job AND post a 💬.
export const CONTROL_RECOVERABLE_FUNCTIONS = ["sync-control-evidence", "rerun-audit"];

// Decide which running rows are stuck. Pure: caller passes the rows + clock.
//
//  - status must be 'running' (a row that already resolved is left alone).
//  - never sweep the watchman's own rows (it is itself a running job while it works).
//  - age must exceed thresholdMinutes (one edge invocation can't outlive its
//    wall-clock budget, so anything older is a killed/orphaned worker, not slow work).
export function planSweep(args: {
  rows: JobRunRow[];
  nowMs: number;
  thresholdMinutes: number;
  selfFunctionName: string;
}): SweepDecision[] {
  const thresholdMs = args.thresholdMinutes * 60_000;
  const decisions: SweepDecision[] = [];

  for (const row of args.rows) {
    if (row.status !== "running") continue;
    if (row.function_name === args.selfFunctionName) continue;

    const startedMs = Date.parse(row.started_at);
    if (!Number.isFinite(startedMs)) continue; // unparseable timestamp — skip, don't guess

    const ageMs = args.nowMs - startedMs;
    if (ageMs < thresholdMs) continue;

    const control_uuid = typeof row.payload?.control_uuid === "string"
      ? (row.payload.control_uuid as string)
      : null;

    decisions.push({
      id: row.id,
      function_name: row.function_name,
      engagement_id: row.engagement_id,
      control_uuid,
      stuck_minutes: Math.floor(ageMs / 60_000),
    });
  }

  return decisions;
}

// The message written to the job_runs.error_message when we declare a row dead.
export function sweptErrorMessage(fn: string, stuckMinutes: number): string {
  return `Swept by watchman: stuck in 'running' for ${stuckMinutes}m ` +
    `(${fn} worker timed out / was killed before it could self-report).`;
}

// The auditor-facing recovery message written to the control's "ClearCheck 💬".
// Actionable + tells them re-running is safe (ingest dedupes by file hash, so a
// re-run resumes from where the stall happened rather than redoing everything).
export function recoveryStatus(fn: string, stuckMinutes: number): string {
  if (fn === "sync-control-evidence") {
    return "⚠️ Evidence sync stalled (worker timed out) — press Re-run to continue. " +
      "Already-uploaded files are skipped, so it picks up where it stopped.";
  }
  if (fn === "rerun-audit") {
    return "⚠️ Re-run stalled (worker timed out) — press Re-run again to continue.";
  }
  return `⚠️ Job stalled (${fn}) after ${stuckMinutes}m — please re-run.`;
}
