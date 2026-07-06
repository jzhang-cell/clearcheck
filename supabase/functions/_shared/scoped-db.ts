// scoped-db.ts — the RLS "Stamp + Restrict" data path (ADR-011, §0 resolved →
// direct Postgres). For CLIENT-DATA reads/writes, functions stop using the
// service_role master key (which BYPASSES RLS) and instead run each unit of
// work inside a transaction that:
//   1. Stamp:    set_config('app.current_engagement_id', <id>, true)  — the GUC
//      the 0006 isolation policies read.
//   2. Restrict: SET LOCAL ROLE engagement_scoped                     — the
//      non-bypass role from 0007, so those policies actually bite.
//
// Both are LOCAL/true — scoped to the transaction, auto-reset on commit/rollback,
// so a pooled connection can't leak one engagement's stamp into the next caller.
//
// System tables (prompts, job_runs) and setup (register-engagement) stay on the
// service_role client (getServiceClient) — this helper is ONLY for client data.
//
// Connection: the transaction-mode pooler (port 6543) with prepared statements
// OFF (the pooler can't reuse them across pooled sessions). Prefer an explicit
// SUPABASE_DB_POOLER_URL; fall back to SUPABASE_DB_URL (edge functions auto-
// inject it) so local/dev still works. Note: Supabase blocks the SUPABASE_ prefix
// in Vault, so this secret is stored as DB_POOLER_URL.
import postgres from "npm:postgres@^3";

// UUID shape guard — engagementId is bound into set_config and lands in a uuid
// GUC; reject anything that isn't a UUID before it reaches the DB.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// porsager/postgres handle type — the `sql` tag passed to scoped callbacks.
export type Sql = ReturnType<typeof postgres>;

let cached: Sql | null = null;

function getPool(): Sql {
  if (cached) return cached;
  const url = Deno.env.get("DB_POOLER_URL") ?? Deno.env.get("SUPABASE_DB_URL");
  if (!url) {
    throw new Error(
      "Neither DB_POOLER_URL nor SUPABASE_DB_URL is set — scoped DB path unavailable",
    );
  }
  // prepare:false is REQUIRED for the transaction-mode pooler (6543).
  //
  // Connection-pool sizing matters a LOT here. Each edge-function invocation is
  // its own Deno isolate with its own pool, and porsager/postgres defaults to
  // max:10. When many controls fire at once (sync → run-audit, plus self-chained
  // syncs), N isolates × 10 connections overruns the transaction pooler →
  // "remaining connection slots are reserved" / "no more connections allowed",
  // which then cascades into every downstream symptom (Evidence-Ready-but-no-
  // audit, Partial-Evidence-Ready freezes, register errors, failed uploads).
  //
  // Within a single isolate the scoped calls are sequential per file; the only
  // real concurrency is sync-control-evidence's EVIDENCE_CONCURRENCY (5) file
  // workers. max:5 covers that without serializing, while slashing the per-isolate
  // ceiling from 10 → 5. idle_timeout returns connections to the pooler quickly
  // between calls; max_lifetime caps how long any one is held; connect_timeout
  // fails fast instead of hanging when the pooler is saturated.
  cached = postgres(url, {
    prepare: false,
    max: Math.max(1, Number(Deno.env.get("SCOPED_DB_POOL_MAX") ?? "5")),
    idle_timeout: 20, // seconds — drop idle conns so siblings can reuse the slot
    max_lifetime: 60 * 5, // seconds — recycle long-lived conns
    connect_timeout: 15, // seconds — fail fast when the pooler is saturated
  });
  return cached;
}

// Run `fn` against the DB as the engagement_scoped role with the engagement
// stamp set, all inside one transaction. The callback receives the transaction
// handle (`tx`) — use it for every client-data query in the unit of work.
//
//   const refined = await withEngagementScope(engagementId, async (tx) => {
//     const [control] = await tx`select * from controls where id = ${id}`;
//     await tx`update controls set ... where id = ${id}`;
//     return control;
//   });
//
// A cross-engagement row is invisible/unwritable at the DB (not just in code):
// the 0006 policies filter every statement to the stamped engagement.
export async function withEngagementScope<T>(
  engagementId: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(engagementId)) {
    throw new Error(`withEngagementScope: invalid engagementId ${JSON.stringify(engagementId)}`);
  }
  const sql = getPool();
  return await sql.begin(async (tx) => {
    // Stamp the GUC for this transaction (third arg true = local), then drop to
    // the non-bypass role. Order matters: stamp first so the role's very first
    // policy-checked statement already sees the right engagement.
    await tx`select set_config('app.current_engagement_id', ${engagementId}, true)`;
    await tx`set local role engagement_scoped`;
    return await fn(tx as unknown as Sql);
  }) as T;
}
