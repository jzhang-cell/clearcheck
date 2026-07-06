// Unit tests for the pace-controls pacing math (`planWave` in pace-logic.ts).
// Pure logic, no Airtable/DB needed. Run from the repo root:
//   deno test supabase/functions/pace-controls/pace.test.ts
//
// These cover the tricky bits: the launched-marker filter, the concurrency cap,
// the pending/overshoot guard, and the done condition.

import { assertEquals } from "jsr:@std/assert@^1";
import { planWave } from "./pace-logic.ts";

// Helper: build N control records. `launchedCount` of them have the run field
// already truthy (= already launched); the rest are still pending launch.
function makeRecords(total: number, launchedCount: number, runField = "Run V3 Audit") {
  return Array.from({ length: total }, (_, i) => ({
    id: `rec${i}`,
    fields: i < launchedCount ? { [runField]: true } : {},
  }));
}

Deno.test("launches up to the cap when nothing is in flight", () => {
  const plan = planWave({
    records: makeRecords(20, 0),
    runField: "Run V3 Audit",
    maxConcurrent: 8,
    inflight: 0,
    pending: 0,
  });
  assertEquals(plan.total, 20);
  assertEquals(plan.alreadyLaunched, 0);
  assertEquals(plan.remaining, 20);
  assertEquals(plan.toLaunchIds.length, 8); // cap
  assertEquals(plan.done, false);
});

Deno.test("only fills the FREE slots when some jobs are in flight", () => {
  const plan = planWave({
    records: makeRecords(20, 5), // 5 already launched
    runField: "Run V3 Audit",
    maxConcurrent: 8,
    inflight: 5, // 5 currently running
    pending: 0,
  });
  assertEquals(plan.alreadyLaunched, 5);
  assertEquals(plan.toLaunchIds.length, 3); // 8 cap - 5 in flight
});

Deno.test("launches nothing when the cap is full", () => {
  const plan = planWave({
    records: makeRecords(20, 8),
    runField: "Run V3 Audit",
    maxConcurrent: 8,
    inflight: 8,
    pending: 0,
  });
  assertEquals(plan.toLaunchIds.length, 0);
  assertEquals(plan.done, false);
});

Deno.test("pending holds the line when actual in-flight lags (no overshoot)", () => {
  // Just ticked 8 controls last cycle, but their jobs haven't appeared yet
  // (Airtable automation latency) → inflight reads 0. Without `pending` we'd
  // wrongly launch 8 MORE. With pending=8 we launch 0.
  const plan = planWave({
    records: makeRecords(20, 8),
    runField: "Run V3 Audit",
    maxConcurrent: 8,
    inflight: 0,
    pending: 8,
  });
  assertEquals(plan.toLaunchIds.length, 0);
});

Deno.test("actual in-flight dominates once jobs are visible", () => {
  // Prior wave is now visible (inflight=8) and pending has decayed (0). Still
  // full, so launch nothing.
  const planFull = planWave({
    records: makeRecords(20, 8),
    runField: "Run V3 Audit",
    maxConcurrent: 8,
    inflight: 8,
    pending: 0,
  });
  assertEquals(planFull.toLaunchIds.length, 0);

  // Some ingests finished (inflight dropped to 4) → free 4 slots.
  const planFreed = planWave({
    records: makeRecords(20, 8),
    runField: "Run V3 Audit",
    maxConcurrent: 8,
    inflight: 4,
    pending: 0,
  });
  assertEquals(planFreed.toLaunchIds.length, 4);
});

Deno.test("never launches more than remain", () => {
  const plan = planWave({
    records: makeRecords(10, 8), // only 2 left to launch
    runField: "Run V3 Audit",
    maxConcurrent: 8,
    inflight: 0,
    pending: 0,
  });
  assertEquals(plan.remaining, 2);
  assertEquals(plan.toLaunchIds.length, 2); // not 8
});

Deno.test("done when every control is launched", () => {
  const plan = planWave({
    records: makeRecords(12, 12),
    runField: "Run V3 Audit",
    maxConcurrent: 8,
    inflight: 0,
    pending: 0,
  });
  assertEquals(plan.done, true);
  assertEquals(plan.remaining, 0);
  assertEquals(plan.toLaunchIds.length, 0);
});

Deno.test("done on an empty control set", () => {
  const plan = planWave({
    records: [],
    runField: "Run V3 Audit",
    maxConcurrent: 8,
    inflight: 0,
    pending: 0,
  });
  assertEquals(plan.done, true);
  assertEquals(plan.total, 0);
});

Deno.test("fail-safe: a huge inflight (job_runs read error fallback) launches nothing", () => {
  // countInFlight returns DEFAULT_MAX_CONCURRENT on error; if that ever exceeds
  // the cap, slots clamp to 0 (never negative).
  const plan = planWave({
    records: makeRecords(20, 0),
    runField: "Run V3 Audit",
    maxConcurrent: 8,
    inflight: 999,
    pending: 0,
  });
  assertEquals(plan.toLaunchIds.length, 0);
});

// --- Two-level cap: global + per-engagement fair share (two engagements running at once) ---

Deno.test("fair share: two active engagements each get half the global cap", () => {
  // Kota + Gallium both pacing: ceil(8/2) = 4 slots each, NOT 8 each (which
  // would sum to 16 in-flight and re-exhaust the pooler).
  const plan = planWave({
    records: makeRecords(20, 0),
    runField: "Run V3 Audit",
    maxConcurrent: 8,
    inflight: 0,
    pending: 0,
    othersInflight: 0,
    activeEngagements: 2,
  });
  assertEquals(plan.toLaunchIds.length, 4);
});

Deno.test("global cap binds when other engagements already fill the pool", () => {
  // Other engagement is running 7 jobs; our fair share says 4 but only 1 global
  // slot is free — the smaller (global) limit wins.
  const plan = planWave({
    records: makeRecords(20, 0),
    runField: "Run V3 Audit",
    maxConcurrent: 8,
    inflight: 0,
    pending: 0,
    othersInflight: 7,
    activeEngagements: 2,
  });
  assertEquals(plan.toLaunchIds.length, 1);
});

Deno.test("fair share binds when this engagement is at its share", () => {
  // We already run 4 of 8 with a second engagement active — no more for us even
  // though 4 global slots remain (they're the other engagement's share).
  const plan = planWave({
    records: makeRecords(20, 4),
    runField: "Run V3 Audit",
    maxConcurrent: 8,
    inflight: 4,
    pending: 0,
    othersInflight: 0,
    activeEngagements: 2,
  });
  assertEquals(plan.toLaunchIds.length, 0);
});

Deno.test("fair share never rounds to zero (three engagements still progress)", () => {
  // ceil(8/3) = 3: every active engagement keeps at least one slot, so nobody
  // deadlocks waiting for the others to finish.
  const plan = planWave({
    records: makeRecords(20, 0),
    runField: "Run V3 Audit",
    maxConcurrent: 8,
    inflight: 0,
    pending: 0,
    othersInflight: 5,
    activeEngagements: 3,
  });
  assertEquals(plan.toLaunchIds.length, 3); // min(global 8-5=3, share 3)
});

Deno.test("single engagement keeps the full cap (backwards compatible)", () => {
  const plan = planWave({
    records: makeRecords(20, 0),
    runField: "Run V3 Audit",
    maxConcurrent: 8,
    inflight: 0,
    pending: 0,
    othersInflight: 0,
    activeEngagements: 1,
  });
  assertEquals(plan.toLaunchIds.length, 8);
});
