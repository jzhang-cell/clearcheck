// queue-logic.ts — pure decision logic for the audit-worker (ADR-015), kept
// separate from index.ts (like pace-logic.ts / sweep-logic.ts) so the
// retry/dead-letter decisions are unit-testable with no DB/HTTP. See
// queue.test.ts.

// An audit_queue row, as returned by the claim_audit_jobs RPC.
export interface QueueJobRow {
  id: string;
  engagement_id: string;
  control_uuid: string;
  status: string;
  attempts: number; // counts CLAIMS (bumped by claim_audit_jobs), not failures
  enqueued_at: string; // ISO timestamp
  last_error: string | null;
}

// attempts counts claims because a worker killed by the platform never reports
// back — the claim is the only moment we can be sure to count. maxAttempts is
// how many claims may actually RUN; a claim beyond that is "spent" and the row
// dead-letters instead of burning another Opus call on a deterministic failure.
export function isSpent(attempts: number, maxAttempts: number): boolean {
  return attempts > maxAttempts;
}

// Backoff before the next claim after an EXPLICIT failure on claim number
// `attempts` (1-based): 2m, 4m, 8m…, capped. Transient causes (rate limits,
// pooler pressure) clear on this scale; deterministic ones hit the attempts cap
// and dead-letter. A worker KILL doesn't come through here — the lease expiry
// (claim RPC) is its retry path.
export function retryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(1, attempts), 15) * 60_000;
}

// Map a pipeline outcome to the queue action.
//   - ok            → done
//   - 404/403       → dead: the control is gone or invisible to its engagement —
//                     retrying cannot fix that, and the row would just cycle.
//   - anything else → retry with backoff (400 refinement-pending may resolve
//                     when refine catches up; 500s are transient until the
//                     attempts cap says otherwise).
export type JobAction = "done" | "retry" | "dead";

export function classifyOutcome(ok: boolean, status: number): JobAction {
  if (ok) return "done";
  if (status === 404 || status === 403) return "dead";
  return "retry";
}

// Auditor-facing 💬 for a dead-lettered row — same actionable idiom as the
// watchman's recoveryStatus (re-running is safe: ingest dedupes, and a fresh
// Re-run enqueues a fresh row).
export function deadLetterMessage(attempts: number, lastError: string | null): string {
  const plural = attempts === 1 ? "" : "s";
  const reason = lastError
    ? ` Last error: ${lastError.length > 140 ? `${lastError.slice(0, 140)}…` : lastError}`
    : "";
  return `⚠️ Audit could not complete after ${attempts} attempt${plural} — ` +
    `press Re-run to try again.${reason}`;
}
