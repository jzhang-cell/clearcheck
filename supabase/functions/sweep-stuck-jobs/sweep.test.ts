// Unit tests for the watchman's stuck-detection logic (`planSweep` in sweep-logic.ts).
// Pure logic, no DB/Airtable needed. Run from the repo root:
//   deno test supabase/functions/sweep-stuck-jobs/sweep.test.ts
//
// These cover the safety-critical bits: the age threshold (don't sweep live work),
// the status filter, the self-exclusion (never sweep the watchman itself), and the
// control_uuid extraction used to target the recovery 💬.

import { assertEquals } from "jsr:@std/assert@^1";
import {
  type ExternalExtractionJobRow,
  type JobRunRow,
  planExternalSweep,
  planSweep,
  recoveryStatus,
} from "./sweep-logic.ts";

const NOW = Date.parse("2026-06-30T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function row(over: Partial<JobRunRow>): JobRunRow {
  return {
    id: "job1",
    function_name: "sync-control-evidence",
    status: "running",
    started_at: minutesAgo(20),
    engagement_id: "eng1",
    payload: { control_uuid: "ctrl1" },
    ...over,
  };
}

Deno.test("sweeps a running row older than the threshold", () => {
  const out = planSweep({
    rows: [row({ started_at: minutesAgo(20) })],
    nowMs: NOW,
    thresholdMinutes: 8,
    selfFunctionName: "sweep-stuck-jobs",
  });
  assertEquals(out.length, 1);
  assertEquals(out[0].control_uuid, "ctrl1");
  assertEquals(out[0].stuck_minutes, 20);
});

Deno.test("leaves a young running row alone (live work, not stuck)", () => {
  const out = planSweep({
    rows: [row({ started_at: minutesAgo(3) })],
    nowMs: NOW,
    thresholdMinutes: 8,
    selfFunctionName: "sweep-stuck-jobs",
  });
  assertEquals(out.length, 0);
});

Deno.test("ignores rows that already resolved (success/failed)", () => {
  const out = planSweep({
    rows: [
      row({ id: "a", status: "success" }),
      row({ id: "b", status: "failed" }),
    ],
    nowMs: NOW,
    thresholdMinutes: 8,
    selfFunctionName: "sweep-stuck-jobs",
  });
  assertEquals(out.length, 0);
});

Deno.test("never sweeps the watchman's own rows", () => {
  const out = planSweep({
    rows: [row({ function_name: "sweep-stuck-jobs", started_at: minutesAgo(30) })],
    nowMs: NOW,
    thresholdMinutes: 8,
    selfFunctionName: "sweep-stuck-jobs",
  });
  assertEquals(out.length, 0);
});

Deno.test("system jobs (no control_uuid) are swept but carry null control_uuid", () => {
  const out = planSweep({
    rows: [row({ function_name: "pace-controls", payload: { foo: "bar" } })],
    nowMs: NOW,
    thresholdMinutes: 8,
    selfFunctionName: "sweep-stuck-jobs",
  });
  assertEquals(out.length, 1);
  assertEquals(out[0].control_uuid, null);
});

Deno.test("skips rows with an unparseable started_at rather than guessing", () => {
  const out = planSweep({
    rows: [row({ started_at: "not-a-date" })],
    nowMs: NOW,
    thresholdMinutes: 8,
    selfFunctionName: "sweep-stuck-jobs",
  });
  assertEquals(out.length, 0);
});

Deno.test("recovery message tells the auditor re-running is safe for sync", () => {
  const msg = recoveryStatus("sync-control-evidence", 12);
  assertEquals(msg.includes("Re-run"), true);
  assertEquals(msg.includes("skipped"), true);
});

function externalRow(over: Partial<ExternalExtractionJobRow>): ExternalExtractionJobRow {
  return {
    id: "external1",
    sync_run_id: "sync1",
    engagement_id: "eng1",
    control_uuid: "ctrl1",
    evidence_file_id: "file1",
    filename: "report.pdf",
    status: "processing",
    updated_at: minutesAgo(130),
    ...over,
  };
}

Deno.test("sweeps a Make job only after the external stale threshold", () => {
  const staleMs = 120 * 60_000;
  assertEquals(
    planExternalSweep({
      rows: [externalRow({ updated_at: minutesAgo(130) })],
      nowMs: NOW,
      staleMs,
    }).length,
    1,
  );
  assertEquals(
    planExternalSweep({
      rows: [externalRow({ updated_at: minutesAgo(40) })],
      nowMs: NOW,
      staleMs,
    }).length,
    0,
  );
});

Deno.test("external sweep ignores completed jobs and unreadable timestamps", () => {
  const rows = [
    externalRow({ id: "done", status: "completed" }),
    externalRow({ id: "bad-time", updated_at: "not-a-date" }),
  ];
  assertEquals(
    planExternalSweep({ rows, nowMs: NOW, staleMs: 120 * 60_000 }),
    [],
  );
});
