// pace-controls — the durable fan-out THROTTLE (ADR-014, Batch Test 01).
//
// Problem it solves: an engagement run launches every control at once. Each
// control's evidence-ingest (sync-control-evidence) opens several DB connections,
// so dozens of controls firing together exhaust the Postgres pooler ("no more
// connections allowed"), which cascades into every downstream failure we saw in
// docs/BATCH_TEST_01.md. The Airtable tick script CAN'T fix this — it's capped at
// ~30s and has no setTimeout, so it can only spread the initial burst, not pace
// to completion.
//
// What this does instead: server-side (no 30s cap), it launches controls in
// WAVES, keeping the number of IN-FLIGHT connection-heavy jobs under a cap. It
// "launches" a control the same way the tick script does — by setting its
// "Run V3 Audit" field, which fires the existing per-control automation. So the
// per-control orchestration is unchanged; only the PACING moves here.
//
// Gating signal: the count of RUNNING register/refine/sync jobs across ALL
// engagements (job_runs) — the pooler is shared, so the cap must be global.
// planWave additionally fair-shares the global cap among active engagements
// (ceil(cap / active)) so a concurrent client can't be starved. Sync is the
// connection-heavy phase (≈5 conns each via EVIDENCE_CONCURRENCY); run-audit is
// connection-light + long, so we don't gate on it. With the scoped-db max:5 cap
// and a ~50–70 pooler, MAX_CONCURRENT≈8 keeps peak connections (~40) safely under.
//
// Survives the edge wall-clock limit by SELF-CHAINING: it paces within a time
// budget, then re-invokes itself to continue, just like sync-control-evidence.
//
// Auth: per-engagement key (x-audit-secret), same as the other per-control fns.
// Trigger: the engagement automation runs `tick-controls-via-coordinator.js`,
// which POSTs here once with the controls table id.
//
// Request body:
//   controls_table_id    (required) — Airtable table id of the controls table
//   engagement_table_id  (optional) — Airtable table id of the engagement table
//   engagement_record_id (optional) — the engagement record id (for the 💬 field)
//   run_field            (optional) — defaults to "Run V3 Audit"
//   max_concurrent       (optional) — overrides PACE_MAX_CONCURRENT / default 8

import { getServiceClient } from "../_shared/supabase-client.ts";
import { resolveEngagementByKey } from "../_shared/auth.ts";
import { listAirtableRecords, patchAirtableRecord } from "../_shared/airtable.ts";
import { completeJobRun, failJobRun, startJobRun } from "../_shared/job-run.ts";
import { fetchWithRetry } from "../_shared/retry.ts";
import { planWave } from "./pace-logic.ts";

const DEFAULT_MAX_CONCURRENT = Math.max(
  1,
  Number(Deno.env.get("PACE_MAX_CONCURRENT") ?? "8"),
);
const PACE_SLEEP_MS = Math.max(1000, Number(Deno.env.get("PACE_SLEEP_MS") ?? "8000"));
// Pace within this wall-clock budget, then self-chain. Keep well under the edge
// background-task limit so we re-invoke before being killed.
const PACE_BUDGET_MS = Math.max(20_000, Number(Deno.env.get("PACE_BUDGET_MS") ?? "45000"));

interface RequestPayload {
  controls_table_id?: string;
  engagement_table_id?: string;
  engagement_record_id?: string;
  run_field?: string;
  max_concurrent?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Count RUNNING jobs in a control's "starting + ingesting" phase — the
// connection-heavy / connection-opening in-flight set. We count
// register/refine/sync (not run-audit, which is long + connection-light) so a
// just-ticked control occupies a slot IMMEDIATELY (its register job starts within
// ~1–2s), before its sync job appears — otherwise the register→sync lag would let
// us overshoot the next wave.
//
// Counted ACROSS engagements, not just this one: the pooler the cap protects is
// shared, so two engagements each pacing to maxConcurrent in isolation would sum
// to 2× the safe ceiling (the Batch Test 01 failure, one level up). planWave
// enforces global cap + per-engagement fair share from this snapshot.
const IN_FLIGHT_FUNCTIONS = [
  "register-control",
  "refine-control",
  "sync-control-evidence",
];

// Ignore 'running' rows older than this when counting in-flight work. No edge
// invocation can legitimately run this long, so an older row is an orphan from a
// killed worker — NOT live work. Batch Test 04 challenge #1: 143 dead rows from
// June counted as in-flight, planWave saw zero slots, and pacing launched
// nothing in any base. The sweeper normally fails such rows first (8m threshold,
// 5m cadence), but pacing correctness must not depend on the sweeper being
// deployed/scheduled — this filter is the belt to its suspenders.
const STALE_INFLIGHT_MIN = Math.max(5, Number(Deno.env.get("STALE_INFLIGHT_MIN") ?? "15"));

interface InFlightSnapshot {
  own: number; // this engagement's running jobs
  others: number; // all other engagements' running jobs
  activeEngagements: number; // engagements with in-flight work, incl. this one
}
async function countInFlight(engagementId: string): Promise<InFlightSnapshot> {
  const supabase = getServiceClient();
  const freshCutoff = new Date(Date.now() - STALE_INFLIGHT_MIN * 60_000).toISOString();
  const { data, error } = await supabase
    .from("job_runs")
    .select("engagement_id")
    .in("function_name", IN_FLIGHT_FUNCTIONS)
    .eq("status", "running")
    .gte("started_at", freshCutoff);
  if (error) {
    console.error(`countInFlight failed: ${error.message}`);
    // Fail safe: report own as "full" so planWave launches nothing this cycle.
    return { own: DEFAULT_MAX_CONCURRENT, others: 0, activeEngagements: 1 };
  }
  let own = 0;
  let others = 0;
  const engagements = new Set<string>([engagementId]);
  for (const row of data ?? []) {
    const eid = (row as { engagement_id: string | null }).engagement_id;
    if (eid === engagementId) own++;
    else if (eid) {
      others++;
      engagements.add(eid);
    }
  }
  return { own, others, activeEngagements: engagements.size };
}

// Fire-and-forget re-invoke of THIS function to continue pacing past the budget.
// Retried (Batch Test 04 follow-up): a single dropped POST here silently ended
// pacing for the whole engagement. The target acks 202 before pacing, so a 5xx
// almost certainly means it never started and a retry is safe.
async function triggerSelf(inboundKey: string, body: RequestPayload): Promise<void> {
  const base = Deno.env.get("SUPABASE_URL");
  if (!base || !inboundKey) {
    console.error("triggerSelf(pace-controls): missing SUPABASE_URL or inbound key — skipping");
    return;
  }
  try {
    const res = await fetchWithRetry(`${base}/functions/v1/pace-controls`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-audit-secret": inboundKey },
      body: JSON.stringify(body),
    }, { label: "trigger pace-controls" });
    if (!res.ok) console.error(`triggerSelf(pace-controls): HTTP ${res.status}`);
  } catch (e) {
    console.error(`triggerSelf(pace-controls) failed: ${(e as Error).message}`);
  }
}

Deno.serve(async (req: Request) => {
  const authResult = await resolveEngagementByKey(req);
  if ("error" in authResult) return authResult.error;
  const { engagementId } = authResult;
  const inboundKey = req.headers.get("x-audit-secret") ?? "";

  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let payload: RequestPayload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (typeof payload.controls_table_id !== "string" || !payload.controls_table_id) {
    return jsonResponse({ error: "Missing or invalid 'controls_table_id'" }, 400);
  }
  const controlsTableId = payload.controls_table_id;
  const engagementTableId = payload.engagement_table_id ?? null;
  const engagementRecordId = payload.engagement_record_id ?? null;
  const runField = payload.run_field ?? "Run V3 Audit";
  const maxConcurrent = Math.max(1, Number(payload.max_concurrent) || DEFAULT_MAX_CONCURRENT);

  // Engagement's real Airtable base id (app...) — needed for every write-back.
  const supabase = getServiceClient();
  const { data: eng, error: engErr } = await supabase
    .from("engagements")
    .select("airtable_base")
    .eq("id", engagementId)
    .maybeSingle();
  if (engErr) return jsonResponse({ error: engErr.message }, 500);
  const airtableBase: string | null = eng?.airtable_base ?? null;

  // The engagement 💬 lives on the engagement table — so it needs the engagement
  // table id + record id (passed by the trigger script). If absent, we skip the
  // status write (best-effort) but still pace; job_runs carries the real state.
  const setEngagementStatus = async (msg: string) => {
    if (!airtableBase || !engagementTableId || !engagementRecordId) return;
    await patchAirtableRecord({
      baseId: airtableBase,
      tableId: engagementTableId,
      recordId: engagementRecordId,
      fields: { "💬": msg },
    }).catch((e) => console.warn(`engagement 💬 write failed: ${e.message}`));
  };

  const job = await startJobRun({
    function_name: "pace-controls",
    trigger_source: "airtable",
    payload: {
      controls_table_id: controlsTableId,
      run_field: runField,
      max_concurrent: maxConcurrent,
    },
    engagement_id: engagementId,
  });

  const pace = async () => {
    const startTime = Date.now();
    let lastTotal = 0;
    let lastLaunched = 0;
    // Controls ticked in the PREVIOUS cycle that may not yet show in job_runs
    // (Airtable automation start-latency). Counting them as occupying slots for
    // one more cycle prevents overshooting the next wave while their jobs appear.
    let pending = 0;
    try {
      while (Date.now() - startTime < PACE_BUDGET_MS) {
        // Read the current control set; "launched" = run field already truthy.
        const list = await listAirtableRecords({
          baseId: airtableBase,
          tableId: controlsTableId,
          fields: [runField],
        });
        if (!list.ok) throw new Error(list.error ?? "Failed to list controls");

        const inflight = await countInFlight(engagementId);
        const plan = planWave({
          records: list.records,
          runField,
          maxConcurrent,
          inflight: inflight.own,
          pending,
          othersInflight: inflight.others,
          activeEngagements: inflight.activeEngagements,
        });
        lastTotal = plan.total;
        lastLaunched = plan.alreadyLaunched;

        if (plan.done) {
          await setEngagementStatus(`✅ All ${lastTotal} controls launched.`);
          await completeJobRun({
            handle: job,
            result: { total: lastTotal, launched: lastLaunched, done: true },
          });
          return;
        }

        let tickedThisCycle = 0;
        for (const id of plan.toLaunchIds) {
          const res = await patchAirtableRecord({
            baseId: airtableBase,
            tableId: controlsTableId,
            recordId: id,
            fields: { [runField]: true },
          });
          if (res.attempted && !res.ok) {
            console.error(`Failed to tick control ${id}: ${res.error}`);
          } else {
            lastLaunched++;
            tickedThisCycle++;
          }
        }
        if (tickedThisCycle > 0) {
          await setEngagementStatus(
            `🚦 Launching audits… ${lastLaunched}/${lastTotal} started, pacing the rest…`,
          );
        }
        pending = tickedThisCycle; // presumed still-starting next cycle
        await sleep(PACE_SLEEP_MS);
      }

      // Budget hit but controls remain — self-chain to continue pacing.
      await completeJobRun({
        handle: job,
        result: { total: lastTotal, launched: lastLaunched, self_chained: true },
      });
      await triggerSelf(inboundKey, {
        controls_table_id: controlsTableId,
        engagement_table_id: engagementTableId ?? undefined,
        engagement_record_id: engagementRecordId ?? undefined,
        run_field: runField,
        max_concurrent: maxConcurrent,
      });
    } catch (err) {
      const e = err as Error;
      await setEngagementStatus(`❌ Pacing failed: ${e.message}`);
      await failJobRun({ handle: job, error_message: e.message, error_stack: e.stack });
    }
  };

  // Background-and-ack in prod (no 30s cap); inline locally for tests/hand calls.
  const edgeRuntime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(pace().catch((e) => console.error(`pace crashed: ${e}`)));
    return jsonResponse(
      {
        accepted: true,
        status: "pacing",
        engagement_id: engagementId,
        max_concurrent: maxConcurrent,
        job_run_id: job.id,
        note: "Controls are being launched in paced waves; this re-invokes itself until done.",
      },
      202,
    );
  }
  await pace();
  return jsonResponse({ success: true, engagement_id: engagementId, job_run_id: job.id });
});
