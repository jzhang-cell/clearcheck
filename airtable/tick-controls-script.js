// TICK-CONTROLS script — ticks "Run V3 Audit" on every control so each fires
// its own per-control run (sync → refine → audit). Reference copy; Airtable runs
// its own copy.
//
// ── STOPGAP THROTTLE (ADR-014) ────────────────────────────
// This is the IMMEDIATE, Airtable-only throttle. It paces the INITIAL burst so
// the connection-heavy evidence-ingest phases don't all start at once and blow
// the Postgres pooler (connection-pool exhaustion). It is NOT a complete throttle:
//   * Airtable's "Run a script" action is capped at ~30s and has NO setTimeout
//     (we busy-wait), so a single run CANNOT pace many controls to completion —
//     each control runs 30s–2min, far longer than any pause we can afford here.
//   * After this script finishes ticking, all ticked controls run concurrently;
//     this only spreads out WHEN they start, within the ~30s budget.
// The durable fix is the server-side `pace-controls` coordinator (no 30s cap,
// gated by live job_runs concurrency). Once that's deployed, point this
// engagement automation at `tick-controls-via-coordinator.js` instead.
//
// What this version improves over the old one:
//   * WAVE_SIZE + PAUSE_MS are configurable (input vars), default to
//     connection-aware values for a ~50–70 pooler with the scoped-db max:5 cap.
//   * Skips controls already ticked, so a re-run resumes instead of re-ticking.
//   * A wall-clock GUARD (~22s) so we never exceed Airtable's ~30s cap: if we
//     can't pace every control in budget, we tick the remainder in one final go
//     and REPORT how many went unpaced (loud, not silent).
//
// Triggered by: automation on the engagement table when "Run_All_V3_Audits" is
// checked (the master script flips that checkbox as its last step).
//
// Input variables (set in the automation's script step):
//   controlsTable           — the controls table name/id (required)
//   runField                — (optional) defaults to "Run V3 Audit"
//   waveSize                — (optional) controls ticked per wave; default 5
//   pauseMs                 — (optional) pause between waves; default 4000

let config = input.config();
const WAVE_SIZE = Math.max(1, Number(config.waveSize) || 5);
const PAUSE_MS = Math.max(0, Number(config.pauseMs) || 4000);
// Stay safely under Airtable's ~30s script cap. We reserve budget for the record
// writes themselves; pacing pauses must fit in what's left.
const PACING_BUDGET_MS = 22000;

// Airtable scripting has no setTimeout — busy-wait is the only sleep available.
// It counts against the ~30s cap, which is exactly why total pacing is bounded.
const sleep = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy-wait */ }
  return Promise.resolve();
};

const startedAt = Date.now();
let controls = base.getTable(config.controlsTable);
let runField = config.runField || "Run V3 Audit";
let query = await controls.selectRecordsAsync({ fields: [runField] });

// Only tick controls that aren't already ticked (idempotent re-runs / resume).
let updates = query.records
  .filter((r) => !r.getCellValue(runField))
  .map((r) => ({ id: r.id, fields: { [runField]: true } }));

let pacedTicked = 0; // ticked WITH a pacing pause before the next wave
let rushTicked = 0; // ticked without pacing because we ran out of time budget

while (updates.length > 0) {
  let batch = updates.slice(0, WAVE_SIZE);
  await controls.updateRecordsAsync(batch);
  updates = updates.slice(WAVE_SIZE);

  if (updates.length === 0) {
    pacedTicked += batch.length; // last batch — no pause needed
    break;
  }
  // If pacing the next wave would risk the ~30s cap, stop pausing and tick the
  // rest as fast as Airtable allows — better to launch them un-paced than to be
  // killed mid-loop and leave controls never ticked.
  const overBudget = Date.now() - startedAt + PAUSE_MS > PACING_BUDGET_MS;
  if (overBudget) {
    rushTicked += batch.length;
  } else {
    pacedTicked += batch.length;
    await sleep(PAUSE_MS);
  }
}

const totalTicked = pacedTicked + rushTicked;
output.set("ticked", totalTicked);
output.set("paced", pacedTicked);
output.set("unpaced", rushTicked); // > 0 means we hit the 30s budget — use the coordinator
if (rushTicked > 0) {
  console.warn(
    `Ticked ${totalTicked} controls but only paced ${pacedTicked}; ${rushTicked} were ` +
      `launched un-paced because the ~30s script cap was approaching. For a complete ` +
      `throttle deploy the pace-controls coordinator (ADR-014).`,
  );
}
