// audit-queue.ts — enqueue side of the durable sync → run-audit handoff
// (ADR-015). audit_queue is a SYSTEM table (like job_runs): rows are written on
// the service client, and the audit-worker claims them via the
// claim_audit_jobs RPC. Durability lives in the row, not in any network call —
// a lost kick or killed worker delays the audit, it no longer loses it.

import { getServiceClient } from "./supabase-client.ts";

export interface EnqueueResult {
  queued: boolean;
  already?: boolean; // a live row for this control already existed (dedupe hit)
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Durably enqueue "audit control X". The partial unique index
// audit_queue_one_live_per_control makes a double-enqueue (double-tick, re-run
// racing a sync, redundant kick) collapse into the existing live row — a 23505
// conflict here IS success. Retried a few times because this insert is now the
// single handoff point: if it ultimately fails the caller must surface it
// loudly (💬), not swallow it like the old fire-and-forget trigger did.
export async function enqueueAudit(
  engagementId: string,
  controlUuid: string,
): Promise<EnqueueResult> {
  const supabase = getServiceClient();
  let lastError = "unknown";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await supabase
      .from("audit_queue")
      .insert({ engagement_id: engagementId, control_uuid: controlUuid });
    if (!error) return { queued: true };
    if (error.code === "23505") return { queued: true, already: true };
    lastError = error.message;
    console.warn(`enqueueAudit attempt ${attempt}/3 failed: ${lastError}`);
    if (attempt < 3) await sleep(500 * attempt);
  }
  return { queued: false, error: lastError };
}

// Best-effort kick so the worker picks the job up NOW instead of at the next
// cron tick. Loss is harmless — the every-minute cron poke is the delivery
// guarantee, so a dropped kick costs ≤60s of latency, never the audit. Uses the
// shared system secret (project-wide env), NOT the caller's per-engagement key:
// the worker is a system function and the queue row already carries the
// engagement identity.
export async function kickAuditWorker(triggerSource = "kick"): Promise<void> {
  const base = Deno.env.get("SUPABASE_URL");
  const secret = Deno.env.get("AUDIT_SHARED_SECRET");
  if (!base || !secret) {
    console.warn(
      "kickAuditWorker: missing SUPABASE_URL or AUDIT_SHARED_SECRET — cron will pick up",
    );
    return;
  }
  try {
    const res = await fetch(`${base}/functions/v1/audit-worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-audit-secret": secret },
      body: JSON.stringify({ trigger_source: triggerSource }),
    });
    if (!res.ok) console.warn(`kickAuditWorker: HTTP ${res.status} (cron will pick up)`);
  } catch (e) {
    console.warn(`kickAuditWorker failed: ${(e as Error).message} (cron will pick up)`);
  }
}
