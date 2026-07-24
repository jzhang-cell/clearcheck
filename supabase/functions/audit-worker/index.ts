// audit-worker — the durable-queue CONSUMER for audits (ADR-015, Batch Test 04
// challenge #3). sync-control-evidence enqueues "audit control X" into
// audit_queue; this function claims rows in small leased batches and runs the
// shared audit pipeline for each. The handoff that used to be one droppable
// POST is now: a durable row + an every-minute cron poke (migration 0015) +
// a best-effort kick for latency. A killed worker simply lets its lease lapse
// and the row is reclaimed — no more "Evidence ready" controls silently
// stalling with no error anywhere.
//
// Why the worker IMPORTS the pipeline instead of POSTing to run-audit:
// per-engagement keys are stored only as SHA-256 hashes, so a cron-woken
// worker has no plaintext key to forward. The queue row (written by an
// authenticated caller) carries the engagement identity; the pipeline scopes
// every client-data query via withEngagementScope, so RLS still bites.
//
// Batch sizing: WORKER_BATCH audits run CONCURRENTLY in this one isolate
// (they're API-bound — Opus/Sonnet — and connection-light). Small on purpose:
// each audit is 1–3 min and the edge wall clock kills isolates around ~150–170s,
// so a big batch would routinely die mid-flight. Death is safe (leases) but
// wastes Opus spend — keep the batch small and let the self-kick + cron drain
// the queue across invocations instead.
//
// Auth: SYSTEM function (cross-engagement by nature, like sweep-stuck-jobs) —
// shared AUDIT_SHARED_SECRET, not a per-engagement key.

import { getServiceClient } from "../_shared/supabase-client.ts";
import { checkSharedSecret } from "../_shared/auth.ts";
import { completeJobRun, failJobRun, startJobRun } from "../_shared/job-run.ts";
import { patchAirtableRecord } from "../_shared/airtable.ts";
import { runAuditPipeline } from "../_shared/audit-pipeline.ts";
import { withEngagementScope } from "../_shared/scoped-db.ts";
import { kickAuditWorker } from "../_shared/audit-queue.ts";
import {
  classifyOutcome,
  deadLetterMessage,
  isSpent,
  type QueueJobRow,
  retryDelayMs,
} from "./queue-logic.ts";

const FUNCTION_NAME = "audit-worker";

// Airtable controls table id — stable across base clones (same constant the
// other control-💬 writers use).
const AIRTABLE_CONTROLS_TABLE_ID = "tblZrxDzOKd9FJkbC";
const CONTROL_STATUS_FIELD = "ClearCheck 💬";

// How many audits to claim + run concurrently per invocation. See header note.
const WORKER_BATCH = Math.max(1, Number(Deno.env.get("AUDIT_WORKER_BATCH") ?? "3"));
// Lease on a claimed row. Must comfortably exceed one audit (~1–3 min) so a
// slow-but-alive audit isn't reclaimed out from under its worker; short enough
// that a killed worker's job retries within minutes, not hours.
const LEASE_SECONDS = Math.max(120, Number(Deno.env.get("AUDIT_LEASE_SECONDS") ?? "600"));
// How many claims may RUN before a row dead-letters (💬 tells the auditor).
const MAX_ATTEMPTS = Math.max(1, Number(Deno.env.get("AUDIT_MAX_ATTEMPTS") ?? "3"));

interface RequestPayload {
  trigger_source?: string; // "cron" (0015 poke) | "kick" (enqueue) | "chain" (self)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── queue row state transitions (service client — audit_queue is a system table)

async function markDone(id: string): Promise<void> {
  const { error } = await getServiceClient()
    .from("audit_queue")
    .update({ status: "done", completed_at: new Date().toISOString(), last_error: null })
    .eq("id", id);
  if (error) console.error(`audit_queue markDone ${id} failed: ${error.message}`);
}

async function markRetry(id: string, attempts: number, lastError: string): Promise<void> {
  const { error } = await getServiceClient()
    .from("audit_queue")
    .update({
      status: "pending",
      visible_at: new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
      lease_expires_at: null,
      last_error: lastError.slice(0, 2000),
    })
    .eq("id", id);
  if (error) console.error(`audit_queue markRetry ${id} failed: ${error.message}`);
}

async function markDead(id: string, lastError: string | null): Promise<void> {
  const { error } = await getServiceClient()
    .from("audit_queue")
    .update({
      status: "dead",
      completed_at: new Date().toISOString(),
      last_error: lastError?.slice(0, 2000) ?? null,
    })
    .eq("id", id);
  if (error) console.error(`audit_queue markDead ${id} failed: ${error.message}`);
}

// Dead-letter 💬: tell the auditor this control needs a human Re-run. Resolves
// the Airtable target from the DB (same service-client metadata reads the
// watchman uses). Best-effort — never let a status write fail the sweep of the
// queue itself.
async function postDeadLetterStatus(job: QueueJobRow, message: string): Promise<void> {
  const supabase = getServiceClient();
  const { data: control } = await supabase
    .from("controls")
    .select("airtable_record_id")
    .eq("id", job.control_uuid)
    .maybeSingle();
  const recordId = (control?.airtable_record_id as string | null) ?? null;
  if (!recordId) return;
  const { data: eng } = await supabase
    .from("engagements")
    .select("airtable_base")
    .eq("id", job.engagement_id)
    .maybeSingle();
  const base = (eng?.airtable_base as string | null) ?? null;
  await patchAirtableRecord({
    baseId: base,
    tableId: AIRTABLE_CONTROLS_TABLE_ID,
    recordId,
    fields: { [CONTROL_STATUS_FIELD]: message },
  }).catch(() => {});
}

// Idempotency guard: a completed audit_run for this control SINCE the row was
// enqueued means the enqueued work is already done — e.g. we crashed after the
// audit committed but before markDone, and the lease redelivered the row. Skip
// instead of paying for a duplicate Opus run. Scoped read — RLS applies.
async function alreadyAudited(job: QueueJobRow): Promise<boolean> {
  return await withEngagementScope(job.engagement_id, async (tx) => {
    const rows = await tx<{ ok: number }[]>`
      select 1 as ok from audit_runs
      where control_id = ${job.control_uuid}
        and status = 'completed'
        and started_at >= ${job.enqueued_at}
      limit 1
    `;
    return rows.length > 0;
  });
}

// Process ONE claimed row through to a queue-state transition. Never throws.
async function processJob(job: QueueJobRow): Promise<{ control_uuid: string; action: string }> {
  try {
    if (isSpent(job.attempts, MAX_ATTEMPTS)) {
      await markDead(job.id, job.last_error);
      await postDeadLetterStatus(job, deadLetterMessage(MAX_ATTEMPTS, job.last_error));
      return { control_uuid: job.control_uuid, action: "dead" };
    }

    if (await alreadyAudited(job)) {
      await markDone(job.id);
      return { control_uuid: job.control_uuid, action: "done_idempotent" };
    }

    const result = await runAuditPipeline({
      engagementId: job.engagement_id,
      controlUuid: job.control_uuid,
      triggerSource: "queue",
    });
    const action = classifyOutcome(result.ok, result.status);
    const errText = typeof result.body.error === "string" ? result.body.error : null;

    if (action === "done") {
      await markDone(job.id);
    } else if (action === "dead") {
      await markDead(job.id, errText);
      await postDeadLetterStatus(job, deadLetterMessage(job.attempts, errText));
    } else {
      await markRetry(job.id, job.attempts, errText ?? `pipeline returned ${result.status}`);
    }
    return { control_uuid: job.control_uuid, action };
  } catch (err) {
    // Unexpected throw (the pipeline normally returns errors) — back off + retry.
    const msg = (err as Error).message;
    console.error(`processJob ${job.control_uuid} threw: ${msg}`);
    await markRetry(job.id, job.attempts, msg);
    return { control_uuid: job.control_uuid, action: "retry" };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authErr = checkSharedSecret(req);
  if (authErr) return authErr;

  let payload: RequestPayload = {};
  try {
    payload = await req.json();
  } catch {
    // Tolerate empty/invalid bodies — the poke itself is the message.
  }
  const triggerSource = payload.trigger_source ?? "cron";

  // Claim inline (fast — one RPC) so an empty poke stays a quiet heartbeat:
  // no job_runs row for "claimed 0" keeps the log readable at 1 poke/minute.
  const supabase = getServiceClient();
  const { data, error } = await supabase.rpc("claim_audit_jobs", {
    p_batch: WORKER_BATCH,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) {
    const job = await startJobRun({
      function_name: FUNCTION_NAME,
      trigger_source: triggerSource,
      payload: { batch: WORKER_BATCH },
    }).catch(() => null);
    if (job) await failJobRun({ handle: job, error_message: `claim failed: ${error.message}` });
    return jsonResponse({ error: `claim failed: ${error.message}` }, 500);
  }
  const claimed = (data ?? []) as QueueJobRow[];
  if (claimed.length === 0) {
    return jsonResponse({ success: true, claimed: 0 });
  }

  const job = await startJobRun({
    function_name: FUNCTION_NAME,
    trigger_source: triggerSource,
    payload: { batch: WORKER_BATCH, claimed: claimed.map((c) => c.control_uuid) },
  }).catch(() => null);

  const processBatch = async (): Promise<void> => {
    const results = await Promise.all(claimed.map((c) => processJob(c)));
    const tally = { done: 0, done_idempotent: 0, retry: 0, dead: 0 };
    for (const r of results) tally[r.action as keyof typeof tally]++;
    if (job) {
      await completeJobRun({
        handle: job,
        result: { claimed: claimed.length, ...tally, jobs: results },
      });
    }
    // A full batch suggests more rows are waiting — chain another invocation.
    // Best-effort: if this kick is lost, the next cron poke (≤60s) continues.
    if (claimed.length === WORKER_BATCH) {
      await kickAuditWorker("chain");
    }
  };

  // Background-and-ack in prod (audits are minutes of API waiting); inline
  // locally for tests/hand calls, same dispatch pattern as the other functions.
  const edgeRuntime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(processBatch().catch((e) => console.error(`processBatch crashed: ${e}`)));
    return jsonResponse(
      {
        accepted: true,
        status: "processing",
        claimed: claimed.length,
        job_run_id: job?.id ?? null,
      },
      202,
    );
  }
  await processBatch();
  return jsonResponse({ success: true, claimed: claimed.length, job_run_id: job?.id ?? null });
});
