// sweep-stuck-jobs — ClearCheck's stuck-job watchman and explicit recovery entrypoint.
//
// Two POST modes share this endpoint:
//
// 1. Scheduled cleanup (shared AUDIT_SHARED_SECRET)
//    The existing pg_cron path scans all engagements for old `running` job_runs
//    rows and marks them failed. It returns controls_to_notify for compatibility.
//
// 2. Airtable bad-control recovery (per-engagement key)
//    Airtable sends `bad_control_ids` plus the Audit Overview record id. The
//    function resolves those identifiers to controls, posts progress to the
//    overview row, fails any stale rows for those controls, and launches
//    sync-control-evidence once per control. Sync owns the long-running evidence
//    work and, only after it completes, durably enqueues the same audit pipeline
//    used by run-audit. The sweeper must not call run-audit immediately because
//    sync returns a fast 202 while evidence is still being processed.

import { getAirtableRecord, patchAirtableRecord } from "../_shared/airtable.ts";
import { checkSharedSecret, resolveEngagementByKey } from "../_shared/auth.ts";
import { completeJobRun, failJobRun, startJobRun } from "../_shared/job-run.ts";
import { getServiceClient } from "../_shared/supabase-client.ts";
import { makeExternalStaleMs } from "../_shared/external-extraction.ts";
import {
  jobPayloadMatchesControls,
  matchBadControls,
  normalizeBadControlIds,
  type RecoverableControl,
  sweepingStatus,
} from "./recovery-logic.ts";
import {
  evaluateRecoveryControl,
  recoveryVerificationMessage,
  summarizeRecoveryChecks,
} from "./recovery-verification.ts";
import {
  CONTROL_RECOVERABLE_FUNCTIONS,
  type ExternalExtractionJobRow,
  externalSweptErrorMessage,
  type JobRunRow,
  planExternalSweep,
  planSweep,
  recoveryStatus,
  sweptErrorMessage,
} from "./sweep-logic.ts";

const FUNCTION_NAME = "sweep-stuck-jobs";
// Keep recovery bookkeeping distinct so a hard-killed recovery row can itself
// be found by the scheduled watchman instead of being excluded as "self".
const RECOVERY_JOB_FUNCTION_NAME = "sweep-stuck-jobs-recovery";

// Airtable table ids are stable across the cloned client bases.
const AIRTABLE_CONTROLS_TABLE_ID = "tblZrxDzOKd9FJkbC";
const CONTROL_STATUS_FIELD = "ClearCheck 💬";
const AIRTABLE_OVERVIEW_TABLE_ID = "tblrb4PpeCCIShcnl";
const OVERVIEW_STATUS_FIELD = "💬";

// One entry per swept control-owning job. Retained on the scheduled path for
// response compatibility with the previous Airtable notification workflow.
interface ControlToNotify {
  control_uuid: string;
  engagement_id: string;
  airtable_base: string | null;
  airtable_table_id: string;
  airtable_record_id: string;
  status_field: string;
  message: string;
  function_name: string;
  stuck_minutes: number;
}

interface RequestPayload {
  // Presence of this property selects Airtable recovery mode. Values may be an
  // array, linked-record objects, JSON text, or comma/newline-separated text.
  bad_control_ids?: unknown;
  // Accept both names while the Airtable automation is being wired.
  airtable_overview_record_id?: string;
  overview_record_id?: string;
  trigger_source?: string;
}

interface SyncDispatchResult {
  control_uuid: string;
  control_id: string;
  accepted: boolean;
  status?: number;
  job_run_id?: string | null;
  sync_run_id?: string | null;
  error?: string;
}

interface RecoveryVerificationControl {
  control_uuid: string;
  control_id: string;
  airtable_record_id: string | null;
  sync_run_id: string | null;
}

interface RecoveryVerificationState {
  status: "pending" | "completed" | "failed";
  started_at: string;
  deadline_at: string;
  overview_record_id: string;
  controls: RecoveryVerificationControl[];
  checked_at?: string;
  passed?: number;
  pending?: number;
  failed?: number;
  last_message?: string;
}

interface RecoveryJobResult extends Record<string, unknown> {
  verification?: RecoveryVerificationState;
}

interface RecoveryMonitorRow {
  id: string;
  engagement_id: string;
  result: RecoveryJobResult;
}

// A 'running' row older than this is declared dead. Default 8m leaves wide
// headroom over one edge invocation while recovering true orphans quickly.
const configuredThreshold = Number(Deno.env.get("STUCK_THRESHOLD_MIN") ?? "8");
const STUCK_THRESHOLD_MIN = Number.isFinite(configuredThreshold)
  ? Math.max(2, configuredThreshold)
  : 8;
const configuredRecoveryConcurrency = Number(
  Deno.env.get("SWEEP_RECOVERY_CONCURRENCY") ?? "5",
);
const RECOVERY_DISPATCH_CONCURRENCY = Number.isFinite(configuredRecoveryConcurrency)
  ? Math.max(1, configuredRecoveryConcurrency)
  : 5;
const configuredVerificationTimeout = Number(
  Deno.env.get("SWEEP_VERIFICATION_TIMEOUT_MIN") ?? "240",
);
const RECOVERY_VERIFICATION_TIMEOUT_MIN = Number.isFinite(configuredVerificationTimeout)
  ? Math.max(30, configuredVerificationTimeout)
  : 240;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isRecoveryRequest(payload: RequestPayload): boolean {
  return Object.prototype.hasOwnProperty.call(payload, "bad_control_ids");
}

async function patchOverviewStatus(
  airtableBase: string,
  overviewRecordId: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await patchAirtableRecord({
    baseId: airtableBase,
    tableId: AIRTABLE_OVERVIEW_TABLE_ID,
    recordId: overviewRecordId,
    fields: { [OVERVIEW_STATUS_FIELD]: message },
  });
  if (!result.attempted) {
    return { ok: false, error: `Airtable progress write skipped: ${result.skip_reason}` };
  }
  if (!result.ok) return { ok: false, error: result.error ?? "Airtable progress write failed" };
  return { ok: true };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

function latestByControl<T extends { control_uuid: string }>(rows: T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const row of rows) {
    if (!latest.has(row.control_uuid)) latest.set(row.control_uuid, row);
  }
  return latest;
}

async function verifyOneRecoveryMonitor(
  row: RecoveryMonitorRow,
): Promise<"pending" | "completed" | "failed"> {
  const verification = row.result.verification;
  if (!verification || verification.status !== "pending") return "completed";
  if (!verification.controls.length) {
    throw new Error(`Recovery monitor ${row.id} has no controls`);
  }

  const supabase = getServiceClient();
  const controlUuids = verification.controls.map((control) => control.control_uuid);
  const syncRunIds = verification.controls
    .map((control) => control.sync_run_id)
    .filter((id): id is string => Boolean(id));

  const [
    engagementResponse,
    syncResponse,
    auditResponse,
    queueResponse,
    auditJobResponse,
  ] = await Promise.all([
    supabase.from("engagements").select("airtable_base").eq("id", row.engagement_id).maybeSingle(),
    syncRunIds.length > 0
      ? supabase
        .from("evidence_sync_runs")
        .select("id,status,error_message")
        .in("id", syncRunIds)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("audit_runs")
      .select("control_id,status,error_message,started_at")
      .eq("engagement_id", row.engagement_id)
      .in("control_id", controlUuids)
      .gte("started_at", verification.started_at)
      .order("started_at", { ascending: false })
      .limit(500),
    supabase
      .from("audit_queue")
      .select("control_uuid,status,last_error,enqueued_at")
      .eq("engagement_id", row.engagement_id)
      .in("control_uuid", controlUuids)
      .gte("enqueued_at", verification.started_at)
      .order("enqueued_at", { ascending: false })
      .limit(500),
    supabase
      .from("job_runs")
      .select("status,error_message,payload,result,started_at")
      .eq("engagement_id", row.engagement_id)
      .eq("function_name", "run-audit")
      .gte("started_at", verification.started_at)
      .order("started_at", { ascending: false })
      .limit(500),
  ]);

  for (
    const [label, error] of [
      ["engagement", engagementResponse.error],
      ["evidence sync", syncResponse.error],
      ["audit run", auditResponse.error],
      ["audit queue", queueResponse.error],
      ["audit job", auditJobResponse.error],
    ] as const
  ) {
    if (error) throw new Error(`${label} verification query failed: ${error.message}`);
  }

  const airtableBase = (engagementResponse.data?.airtable_base as string | null) ?? null;
  if (!airtableBase) throw new Error(`Recovery monitor ${row.id} has no Airtable base`);

  type SyncRow = { id: string; status: string; error_message: string | null };
  type AuditRow = {
    control_id: string;
    status: string;
    error_message: string | null;
    started_at: string;
  };
  type QueueRow = {
    control_uuid: string;
    status: string;
    last_error: string | null;
    enqueued_at: string;
  };
  type AuditJobRow = {
    status: string;
    error_message: string | null;
    payload: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
    started_at: string;
  };

  const syncById = new Map(
    ((syncResponse.data ?? []) as SyncRow[]).map((sync) => [sync.id, sync]),
  );
  const auditsByControl = latestByControl(
    ((auditResponse.data ?? []) as AuditRow[]).map((audit) => ({
      ...audit,
      control_uuid: audit.control_id,
    })),
  );
  const queuesByControl = latestByControl((queueResponse.data ?? []) as QueueRow[]);
  const auditJobsByControl = latestByControl(
    ((auditJobResponse.data ?? []) as AuditJobRow[])
      .map((auditJob) => ({
        ...auditJob,
        control_uuid: typeof auditJob.payload?.control_uuid === "string"
          ? auditJob.payload.control_uuid
          : "",
      }))
      .filter((auditJob) => controlUuids.includes(auditJob.control_uuid)),
  );

  const airtableReads = await mapWithConcurrency(
    verification.controls,
    5,
    async (control) => {
      const sync = control.sync_run_id ? syncById.get(control.sync_run_id) : undefined;
      const audit = auditsByControl.get(control.control_uuid);
      const auditJob = auditJobsByControl.get(control.control_uuid);
      if (
        sync?.status !== "completed" ||
        audit?.status !== "completed" ||
        auditJob?.status !== "success"
      ) {
        return {
          control_uuid: control.control_uuid,
          message: null,
          error: null,
        };
      }
      if (!control.airtable_record_id) {
        return {
          control_uuid: control.control_uuid,
          message: null,
          error: "control has no Airtable record id",
        };
      }
      const result = await getAirtableRecord({
        baseId: airtableBase,
        tableId: AIRTABLE_CONTROLS_TABLE_ID,
        recordId: control.airtable_record_id,
      });
      return {
        control_uuid: control.control_uuid,
        message: typeof result.record?.fields[CONTROL_STATUS_FIELD] === "string"
          ? result.record.fields[CONTROL_STATUS_FIELD] as string
          : null,
        error: result.ok ? null : result.error ?? "Airtable control read failed",
      };
    },
  );
  const airtableByControl = new Map(
    airtableReads.map((read) => [read.control_uuid, read]),
  );

  const checks = verification.controls.map((control) => {
    const sync = control.sync_run_id ? syncById.get(control.sync_run_id) : undefined;
    const audit = auditsByControl.get(control.control_uuid);
    const queue = queuesByControl.get(control.control_uuid);
    const auditJob = auditJobsByControl.get(control.control_uuid);
    const airtable = airtableByControl.get(control.control_uuid);
    const airtableSync = auditJob?.result?.airtable_sync;
    const airtableWritebackOk = airtableSync && typeof airtableSync === "object"
      ? (airtableSync as Record<string, unknown>).ok
      : null;

    return evaluateRecoveryControl({
      control_id: control.control_id,
      sync_status: sync?.status ?? null,
      sync_error: sync?.error_message ?? null,
      queue_status: queue?.status ?? null,
      queue_error: queue?.last_error ?? null,
      audit_status: audit?.status ?? null,
      audit_error: audit?.error_message ?? null,
      audit_job_status: auditJob?.status ?? null,
      audit_job_error: auditJob?.error_message ?? null,
      airtable_writeback_ok: typeof airtableWritebackOk === "boolean" ? airtableWritebackOk : null,
      airtable_message: airtable?.message ?? null,
      airtable_read_error: airtable?.error ?? null,
    });
  });

  const summary = summarizeRecoveryChecks(checks);
  const timedOut = Date.now() >= Date.parse(verification.deadline_at);
  const nextStatus: RecoveryVerificationState["status"] = summary.failed > 0 || timedOut
    ? "failed"
    : summary.passed === summary.total
    ? "completed"
    : "pending";
  const message = recoveryVerificationMessage(summary, timedOut);

  // Write the user-facing status before closing a terminal monitor. If Airtable
  // is temporarily unavailable, leave it pending so the next cron pass retries
  // instead of losing the final notification.
  if (message !== verification.last_message || nextStatus !== "pending") {
    const patched = await patchOverviewStatus(
      airtableBase,
      verification.overview_record_id,
      message,
    );
    if (!patched.ok) throw new Error(patched.error ?? "Overview verification write failed");
  }

  const nextVerification: RecoveryVerificationState = {
    ...verification,
    status: nextStatus,
    checked_at: new Date().toISOString(),
    passed: summary.passed,
    pending: summary.pending,
    failed: summary.failed,
    last_message: message,
  };
  const { error: updateError } = await supabase
    .from("job_runs")
    .update({
      result: {
        ...row.result,
        verification: nextVerification,
      },
    })
    .eq("id", row.id)
    // Cron invocations can overlap. Only the first verifier that still sees a
    // pending monitor may close it; a later invocation must not overwrite the
    // newer terminal result with its stale snapshot.
    .contains("result", { verification: { status: "pending" } });
  if (updateError) {
    throw new Error(`Failed to save recovery verification: ${updateError.message}`);
  }
  return nextStatus;
}

async function verifyPendingRecoveries(): Promise<{
  checked: number;
  pending: number;
  completed: number;
  failed: number;
  errors: string[];
}> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("job_runs")
    .select("id,engagement_id,result")
    .eq("function_name", RECOVERY_JOB_FUNCTION_NAME)
    .eq("status", "success")
    // Filter in Postgres so completed recovery rows cannot crowd an older
    // pending monitor out of the bounded scan.
    .contains("result", { verification: { status: "pending" } })
    .order("started_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`Recovery monitor scan failed: ${error.message}`);

  const monitors = (data ?? []) as RecoveryMonitorRow[];
  const outcomes = await mapWithConcurrency(monitors, 3, async (monitor) => {
    try {
      return { status: await verifyOneRecoveryMonitor(monitor), error: null };
    } catch (monitorError) {
      const message = `Recovery monitor ${monitor.id}: ${(monitorError as Error).message}`;
      console.error(message);
      return { status: "pending" as const, error: message };
    }
  });

  return {
    checked: monitors.length,
    pending: outcomes.filter((outcome) => outcome.status === "pending").length,
    completed: outcomes.filter((outcome) => outcome.status === "completed").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    errors: outcomes
      .map((outcome) => outcome.error)
      .filter((message): message is string => Boolean(message)),
  };
}

async function launchEvidenceSync(
  control: RecoverableControl,
  perEngagementKey: string,
): Promise<SyncDispatchResult> {
  const base = Deno.env.get("SUPABASE_URL");
  if (!base) {
    return {
      control_uuid: control.id,
      control_id: control.control_id,
      accepted: false,
      error: "SUPABASE_URL is not configured",
    };
  }

  try {
    // Do not automatically retry this POST: a network/5xx response can be
    // ambiguous after sync has already accepted the work, and a retry could
    // launch two evidence workers for the same control.
    const response = await fetch(`${base}/functions/v1/sync-control-evidence`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-audit-secret": perEngagementKey,
      },
      body: JSON.stringify({
        control_uuid: control.id,
        trigger_source: FUNCTION_NAME,
      }),
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      return {
        control_uuid: control.id,
        control_id: control.control_id,
        accepted: false,
        status: response.status,
        error: typeof body.error === "string" ? body.error : text.slice(0, 500),
      };
    }
    return {
      control_uuid: control.id,
      control_id: control.control_id,
      accepted: true,
      status: response.status,
      job_run_id: typeof body.job_run_id === "string" ? body.job_run_id : null,
      sync_run_id: typeof body.sync_run_id === "string" ? body.sync_run_id : null,
    };
  } catch (err) {
    return {
      control_uuid: control.id,
      control_id: control.control_id,
      accepted: false,
      error: (err as Error).message,
    };
  }
}

// Mark stale running rows belonging to the selected controls failed before
// starting fresh syncs. This is engagement-scoped and does not touch other
// clients or healthy/young work.
async function sweepSelectedControlJobs(
  engagementId: string,
  controls: RecoverableControl[],
): Promise<string[]> {
  const supabase = getServiceClient();
  const nowMs = Date.now();
  const cutoffIso = new Date(nowMs - STUCK_THRESHOLD_MIN * 60_000).toISOString();
  const { data, error } = await supabase
    .from("job_runs")
    .select("id, function_name, status, started_at, engagement_id, payload")
    .eq("engagement_id", engagementId)
    .eq("status", "running")
    .lt("started_at", cutoffIso)
    .neq("function_name", FUNCTION_NAME)
    .order("started_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(`job_runs scan failed: ${error.message}`);

  const selectedRows = ((data ?? []) as JobRunRow[]).filter((row) =>
    jobPayloadMatchesControls(row.payload, controls)
  );
  const decisions = planSweep({
    rows: selectedRows,
    nowMs,
    thresholdMinutes: STUCK_THRESHOLD_MIN,
    selfFunctionName: FUNCTION_NAME,
  });

  const sweptIds: string[] = [];
  for (const decision of decisions) {
    const { data: updated, error: updateError } = await supabase
      .from("job_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_message: sweptErrorMessage(decision.function_name, decision.stuck_minutes),
      })
      .eq("id", decision.id)
      .eq("status", "running")
      .select("id");
    if (updateError) {
      console.error(`sweep: failed to mark ${decision.id} failed: ${updateError.message}`);
      continue;
    }
    if ((updated ?? []).length > 0) sweptIds.push(decision.id);
  }
  return sweptIds;
}

async function handleBadControlRecovery(
  req: Request,
  payload: RequestPayload,
): Promise<Response> {
  const authResult = await resolveEngagementByKey(req);
  if ("error" in authResult) return authResult.error;
  const { engagementId } = authResult;
  const perEngagementKey = req.headers.get("x-audit-secret");
  if (!perEngagementKey) return jsonResponse({ error: "Unauthorized" }, 401);

  const identifiers = normalizeBadControlIds(payload.bad_control_ids);
  if (identifiers.length === 0) {
    return jsonResponse({ error: "'bad_control_ids' did not contain any usable identifiers" }, 400);
  }
  const rawOverviewRecordId = payload.airtable_overview_record_id ?? payload.overview_record_id;
  const overviewRecordId = typeof rawOverviewRecordId === "string"
    ? rawOverviewRecordId.trim()
    : "";
  if (!overviewRecordId) {
    return jsonResponse({ error: "Missing 'airtable_overview_record_id'" }, 400);
  }

  const supabase = getServiceClient();
  const [{ data: engagement, error: engagementError }, { data: controlRows, error: controlError }] =
    await Promise.all([
      supabase.from("engagements").select("airtable_base").eq("id", engagementId).maybeSingle(),
      supabase
        .from("controls")
        .select("id, control_id, airtable_record_id, engagement_id")
        .eq("engagement_id", engagementId),
    ]);
  if (engagementError) {
    return jsonResponse({ error: `Engagement lookup failed: ${engagementError.message}` }, 500);
  }
  if (controlError) {
    return jsonResponse({ error: `Control lookup failed: ${controlError.message}` }, 500);
  }
  const airtableBase = (engagement?.airtable_base as string | null) ?? null;
  if (!airtableBase) {
    return jsonResponse({ error: "This engagement has no Airtable base configured" }, 400);
  }

  const matched = matchBadControls(identifiers, (controlRows ?? []) as RecoverableControl[]);
  if (matched.controls.length === 0) {
    await patchOverviewStatus(
      airtableBase,
      overviewRecordId,
      `❌ Sweep stopped — none of the ${identifiers.length} supplied control IDs matched this engagement.`,
    );
    return jsonResponse({
      error: "No supplied controls matched this engagement",
      unmatched: identifiers,
    }, 404);
  }

  const initialStatus = await patchOverviewStatus(
    airtableBase,
    overviewRecordId,
    sweepingStatus(matched.controls.length),
  );
  if (!initialStatus.ok) {
    return jsonResponse({ error: initialStatus.error }, 502);
  }

  let job;
  try {
    job = await startJobRun({
      function_name: RECOVERY_JOB_FUNCTION_NAME,
      trigger_source: payload.trigger_source ?? "airtable",
      engagement_id: engagementId,
      payload: {
        mode: "bad-control-recovery",
        requested_ids: identifiers,
        matched_control_uuids: matched.controls.map((control) => control.id),
        unmatched_ids: matched.unmatched,
        airtable_overview_record_id: overviewRecordId,
      },
    });
  } catch (err) {
    const message = `Failed to start recovery job: ${(err as Error).message}`;
    await patchOverviewStatus(airtableBase, overviewRecordId, `❌ ${message}`);
    return jsonResponse({ error: message }, 500);
  }

  const processRecovery = async () => {
    try {
      const verificationStartedAt = new Date().toISOString();
      const sweptIds = await sweepSelectedControlJobs(engagementId, matched.controls);
      const dispatches = await mapWithConcurrency(
        matched.controls,
        RECOVERY_DISPATCH_CONCURRENCY,
        (control) => launchEvidenceSync(control, perEngagementKey),
      );
      const accepted = dispatches.filter((dispatch) => dispatch.accepted);
      const failed = dispatches.filter((dispatch) => !dispatch.accepted);
      const missingSyncIds = accepted.filter((dispatch) => !dispatch.sync_run_id);
      const unmatchedNote = matched.unmatched.length > 0
        ? ` ${matched.unmatched.length} supplied ID${
          matched.unmatched.length === 1 ? " was" : "s were"
        } not found.`
        : "";
      const canVerifyToSuccess = failed.length === 0 &&
        matched.unmatched.length === 0 &&
        missingSyncIds.length === 0;
      const verificationFailures = failed.length + matched.unmatched.length +
        missingSyncIds.length;
      const status = canVerifyToSuccess
        ? `✅ Sweep started ${accepted.length} ${accepted.length === 1 ? "job" : "jobs"}. ` +
          `Evidence sync is running; ClearCheck will double-check every control before marking ` +
          `the sweep complete.${unmatchedNote}`
        : `⚠️ Sweep started ${accepted.length} of ${matched.controls.length} jobs; ` +
          `${failed.length} failed to start` +
          `${missingSyncIds.length > 0 ? `; ${missingSyncIds.length} returned no sync ID` : ""}.` +
          unmatchedNote;
      await patchOverviewStatus(airtableBase, overviewRecordId, status);

      const verificationControls: RecoveryVerificationControl[] = accepted.map((dispatch) => {
        const control = matched.controls.find((candidate) =>
          candidate.id === dispatch.control_uuid
        )!;
        return {
          control_uuid: control.id,
          control_id: control.control_id,
          airtable_record_id: control.airtable_record_id,
          sync_run_id: dispatch.sync_run_id ?? null,
        };
      });
      const verification: RecoveryVerificationState = {
        status: canVerifyToSuccess ? "pending" : "failed",
        started_at: verificationStartedAt,
        deadline_at: new Date(
          Date.parse(verificationStartedAt) + RECOVERY_VERIFICATION_TIMEOUT_MIN * 60_000,
        ).toISOString(),
        overview_record_id: overviewRecordId,
        controls: verificationControls,
        checked_at: verificationStartedAt,
        passed: 0,
        pending: canVerifyToSuccess ? verificationControls.length : 0,
        failed: canVerifyToSuccess ? 0 : verificationFailures,
        last_message: status,
      };
      const result = {
        mode: "bad-control-recovery",
        requested: identifiers.length,
        matched: matched.controls.length,
        unmatched: matched.unmatched,
        stale_jobs_swept: sweptIds.length,
        swept_ids: sweptIds,
        syncs_accepted: accepted.length,
        syncs_failed: failed.length,
        dispatches,
        verification,
      };
      await completeJobRun({ handle: job, result });
      return {
        body: { success: canVerifyToSuccess, ...result },
        status: canVerifyToSuccess ? 200 : 207,
      };
    } catch (err) {
      const error = err as Error;
      await failJobRun({ handle: job, error_message: error.message, error_stack: error.stack });
      await patchOverviewStatus(
        airtableBase,
        overviewRecordId,
        `❌ Sweep failed before all controls could restart: ${error.message}`,
      );
      return { body: { error: error.message, job_run_id: job.id }, status: 500 };
    }
  };

  const edgeRuntime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(
      processRecovery().catch((error) => console.error(`bad-control recovery crashed: ${error}`)),
    );
    return jsonResponse(
      {
        accepted: true,
        status: "processing",
        requested: identifiers.length,
        matched: matched.controls.length,
        unmatched: matched.unmatched,
        job_run_id: job.id,
        note:
          "Evidence syncs are being launched; the watchman will verify every completed control and update the overview.",
      },
      202,
    );
  }
  const result = await processRecovery();
  return jsonResponse(result.body, result.status);
}

async function handleScheduledSweep(triggerSource: string): Promise<Response> {
  const supabase = getServiceClient();
  const nowMs = Date.now();
  const cutoffIso = new Date(nowMs - STUCK_THRESHOLD_MIN * 60_000).toISOString();
  const externalStaleMs = makeExternalStaleMs();
  const externalCutoffIso = new Date(nowMs - externalStaleMs).toISOString();

  const job = await startJobRun({
    function_name: FUNCTION_NAME,
    trigger_source: triggerSource,
    payload: {
      threshold_min: STUCK_THRESHOLD_MIN,
      make_external_stale_min: Math.round(externalStaleMs / 60_000),
    },
  });

  try {
    const [
      { data, error },
      { data: externalData, error: externalError },
    ] = await Promise.all([
      supabase
        .from("job_runs")
        .select("id, function_name, status, started_at, engagement_id, payload")
        .eq("status", "running")
        .lt("started_at", cutoffIso)
        .neq("function_name", FUNCTION_NAME)
        .order("started_at", { ascending: true })
        .limit(200),
      supabase
        .from("external_extraction_jobs")
        .select(
          "id,sync_run_id,engagement_id,control_uuid,evidence_file_id," +
            "filename,status,updated_at",
        )
        .in("status", ["queued", "processing", "completing"])
        .lt("updated_at", externalCutoffIso)
        .order("updated_at", { ascending: true })
        .limit(200),
    ]);
    if (error) throw new Error(`job_runs scan failed: ${error.message}`);
    if (externalError) {
      throw new Error(`external_extraction_jobs scan failed: ${externalError.message}`);
    }

    const decisions = planSweep({
      rows: (data ?? []) as JobRunRow[],
      nowMs,
      thresholdMinutes: STUCK_THRESHOLD_MIN,
      selfFunctionName: FUNCTION_NAME,
    });
    const externalDecisions = planExternalSweep({
      rows: (externalData ?? []) as unknown as ExternalExtractionJobRow[],
      nowMs,
      staleMs: externalStaleMs,
    });

    const baseCache = new Map<string, string | null>();
    const getAirtableBase = async (engagementId: string): Promise<string | null> => {
      if (baseCache.has(engagementId)) return baseCache.get(engagementId)!;
      const { data: engagement } = await supabase
        .from("engagements")
        .select("airtable_base")
        .eq("id", engagementId)
        .maybeSingle();
      const base = (engagement?.airtable_base as string | null) ?? null;
      baseCache.set(engagementId, base);
      return base;
    };

    const sweptIds: string[] = [];
    const externalSweptIds: string[] = [];
    const controlsToNotify: ControlToNotify[] = [];
    for (const decision of decisions) {
      const { data: updated, error: updateError } = await supabase
        .from("job_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_message: sweptErrorMessage(decision.function_name, decision.stuck_minutes),
        })
        .eq("id", decision.id)
        .eq("status", "running")
        .select("id");
      if (updateError) {
        console.error(`sweep: failed to mark ${decision.id} failed: ${updateError.message}`);
        continue;
      }
      if ((updated ?? []).length === 0) continue;
      sweptIds.push(decision.id);

      if (!CONTROL_RECOVERABLE_FUNCTIONS.includes(decision.function_name)) continue;
      if (!decision.control_uuid || !decision.engagement_id) continue;
      const { data: control } = await supabase
        .from("controls")
        .select("airtable_record_id")
        .eq("id", decision.control_uuid)
        .maybeSingle();
      const recordId = (control?.airtable_record_id as string | null) ?? null;
      if (!recordId) continue;
      controlsToNotify.push({
        control_uuid: decision.control_uuid,
        engagement_id: decision.engagement_id,
        airtable_base: await getAirtableBase(decision.engagement_id),
        airtable_table_id: AIRTABLE_CONTROLS_TABLE_ID,
        airtable_record_id: recordId,
        status_field: CONTROL_STATUS_FIELD,
        message: recoveryStatus(decision.function_name, decision.stuck_minutes),
        function_name: decision.function_name,
        stuck_minutes: decision.stuck_minutes,
      });
    }

    // Make jobs do not have a running job_runs row while the external scenario
    // works, so they need their own conservative stale scan. Claim with both
    // status and updated_at to avoid racing a callback that completed after the
    // initial SELECT. One stale external file fails its owning sync, marks the
    // evidence row retryable, and leaves an actionable Airtable status.
    const externalNotifiedControls = new Set<string>();
    for (const decision of externalDecisions) {
      const message = externalSweptErrorMessage(decision.filename, decision.stuck_minutes);
      const completedAt = new Date().toISOString();
      const { data: updated, error: updateError } = await supabase
        .from("external_extraction_jobs")
        .update({
          status: "failed",
          error_message: message,
          completed_at: completedAt,
          updated_at: completedAt,
        })
        .eq("id", decision.id)
        .eq("status", decision.status)
        .eq("updated_at", decision.updated_at)
        .select("id");
      if (updateError) {
        console.error(
          `sweep: failed to close external job ${decision.id}: ${updateError.message}`,
        );
        continue;
      }
      if ((updated ?? []).length === 0) continue;
      externalSweptIds.push(decision.id);

      const [{ error: fileError }, { error: syncError }] = await Promise.all([
        supabase
          .from("evidence_files")
          .update({ status: "failed", error_message: message })
          .eq("id", decision.evidence_file_id)
          .neq("status", "extracted"),
        supabase
          .from("evidence_sync_runs")
          .update({
            status: "failed",
            error_message: message,
            completed_at: completedAt,
            updated_at: completedAt,
          })
          .eq("id", decision.sync_run_id)
          .in("status", ["dispatching", "waiting_external", "resuming"]),
      ]);
      if (fileError) {
        console.error(`sweep: failed to mark evidence file failed: ${fileError.message}`);
      }
      if (syncError) {
        console.error(`sweep: failed to close evidence sync: ${syncError.message}`);
      }

      if (externalNotifiedControls.has(decision.control_uuid)) continue;
      externalNotifiedControls.add(decision.control_uuid);
      const { data: control } = await supabase
        .from("controls")
        .select("airtable_record_id")
        .eq("id", decision.control_uuid)
        .maybeSingle();
      const recordId = (control?.airtable_record_id as string | null) ?? null;
      if (!recordId) continue;
      const base = await getAirtableBase(decision.engagement_id);
      const airtableMessage =
        `⚠️ Make did not return '${decision.filename}' after ${decision.stuck_minutes} minutes. ` +
        "The job was closed automatically — press Sweep/Run V3 to retry.";
      const notice: ControlToNotify = {
        control_uuid: decision.control_uuid,
        engagement_id: decision.engagement_id,
        airtable_base: base,
        airtable_table_id: AIRTABLE_CONTROLS_TABLE_ID,
        airtable_record_id: recordId,
        status_field: CONTROL_STATUS_FIELD,
        message: airtableMessage,
        function_name: "make-extraction",
        stuck_minutes: decision.stuck_minutes,
      };
      controlsToNotify.push(notice);
      const patched = await patchAirtableRecord({
        baseId: base,
        tableId: AIRTABLE_CONTROLS_TABLE_ID,
        recordId,
        fields: { [CONTROL_STATUS_FIELD]: airtableMessage },
      });
      if (!patched.ok) {
        console.error(
          `sweep: failed to post stale Make status for ${decision.control_uuid}: ${patched.error}`,
        );
      }
    }

    // Recovery dispatch is asynchronous. Every scheduled watchman pass also
    // advances pending recovery monitors and posts the final overview 💬 only
    // after the exact sync, a new audit, and Airtable write-back all verify.
    const recoveryVerifications = await verifyPendingRecoveries().catch((verificationError) => {
      const message = (verificationError as Error).message;
      console.error(`Recovery verification scan failed: ${message}`);
      return {
        checked: 0,
        pending: 0,
        completed: 0,
        failed: 0,
        errors: [message],
      };
    });

    const result = {
      scanned: data?.length ?? 0,
      swept: sweptIds.length,
      external_scanned: externalData?.length ?? 0,
      external_swept: externalSweptIds.length,
      external_stale_min: Math.round(externalStaleMs / 60_000),
      to_notify: controlsToNotify.length,
      threshold_min: STUCK_THRESHOLD_MIN,
      swept_ids: sweptIds,
      external_swept_ids: externalSweptIds,
      controls_to_notify: controlsToNotify,
      recovery_verifications: recoveryVerifications,
    };
    await completeJobRun({ handle: job, result });
    return jsonResponse({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    await failJobRun({ handle: job, error_message: error.message, error_stack: error.stack });
    return jsonResponse({ error: error.message }, 500);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let payload: RequestPayload = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as RequestPayload;
    }
  } catch {
    // The scheduled path historically tolerated an empty body.
  }

  if (isRecoveryRequest(payload)) return await handleBadControlRecovery(req, payload);

  const authError = checkSharedSecret(req);
  if (authError) return authError;
  return await handleScheduledSweep(payload.trigger_source ?? "cron");
});
