// deno-lint-ignore-file no-import-prefix -- matches the repository's existing test imports.
import { assertEquals } from "jsr:@std/assert@^1";
import {
  evaluateRecoveryControl,
  recoveryVerificationMessage,
  summarizeRecoveryChecks,
} from "./recovery-verification.ts";

Deno.test("passes only after sync, audit, and Airtable are all confirmed", () => {
  assertEquals(
    evaluateRecoveryControl({
      control_id: "CC.01.01",
      sync_status: "completed",
      queue_status: "done",
      audit_status: "completed",
      audit_job_status: "success",
      airtable_writeback_ok: true,
      airtable_message: "🥳 Audit complete — No Deviation",
    }),
    {
      control_id: "CC.01.01",
      state: "passed",
      detail: "sync, audit, and Airtable result verified",
    },
  );
});

Deno.test("does not claim success while the audit is still running", () => {
  assertEquals(
    evaluateRecoveryControl({
      control_id: "CC.01.01",
      sync_status: "completed",
      queue_status: "processing",
      audit_status: "running",
      audit_job_status: "running",
      airtable_writeback_ok: null,
      airtable_message: "🧠 ClearCheck is auditing the evidence",
    }).state,
    "pending",
  );
});

Deno.test("surfaces terminal sync and Airtable write-back failures", () => {
  assertEquals(
    evaluateRecoveryControl({
      control_id: "CC.01.01",
      sync_status: "failed",
      sync_error: "Make callback timed out",
    }).state,
    "failed",
  );
  assertEquals(
    evaluateRecoveryControl({
      control_id: "CC.02.02",
      sync_status: "completed",
      audit_status: "completed",
      audit_job_status: "success",
      airtable_writeback_ok: false,
    }).detail,
    "audit completed, but its Airtable result write failed",
  );
});

Deno.test("renders progress, success, failure, and timeout overview messages", () => {
  const passed = { control_id: "CC.01.01", state: "passed" as const, detail: "ok" };
  const pending = { control_id: "CC.02.02", state: "pending" as const, detail: "running" };
  const failed = { control_id: "CC.03.03", state: "failed" as const, detail: "failed" };

  assertEquals(
    recoveryVerificationMessage(summarizeRecoveryChecks([passed])),
    "✅ Sweep complete — double-check passed. All 1 control finished successfully and Airtable results are updated.",
  );
  assertEquals(
    recoveryVerificationMessage(summarizeRecoveryChecks([passed, pending])),
    "⏳ Sweep double-check: 1/2 controls complete; 1 still running.",
  );
  assertEquals(
    recoveryVerificationMessage(summarizeRecoveryChecks([passed, failed])),
    "⚠️ Sweep double-check finished — 1/2 controls look good; 1 still needs attention: CC.03.03.",
  );
  assertEquals(
    recoveryVerificationMessage(summarizeRecoveryChecks([passed, pending]), true),
    "⚠️ Sweep double-check timed out — 1/2 controls look good; 1 is still unfinished: CC.02.02.",
  );
});
