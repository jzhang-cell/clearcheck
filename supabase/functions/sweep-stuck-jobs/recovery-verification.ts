export type RecoveryControlState = "pending" | "passed" | "failed";

export interface RecoveryControlSignals {
  control_id: string;
  sync_status?: string | null;
  sync_error?: string | null;
  queue_status?: string | null;
  queue_error?: string | null;
  audit_status?: string | null;
  audit_error?: string | null;
  audit_job_status?: string | null;
  audit_job_error?: string | null;
  airtable_writeback_ok?: boolean | null;
  airtable_message?: string | null;
  airtable_read_error?: string | null;
}

export interface RecoveryControlCheck {
  control_id: string;
  state: RecoveryControlState;
  detail: string;
}

function terminalFailure(
  label: string,
  error?: string | null,
): string {
  return error?.trim() ? `${label}: ${error.trim()}` : label;
}

// A control passes only after every durable stage says it completed AND the
// auditor-facing Airtable row confirms that the final result was written.
export function evaluateRecoveryControl(
  signals: RecoveryControlSignals,
): RecoveryControlCheck {
  if (signals.sync_status === "failed") {
    return {
      control_id: signals.control_id,
      state: "failed",
      detail: terminalFailure("evidence sync failed", signals.sync_error),
    };
  }
  if (signals.queue_status === "dead") {
    return {
      control_id: signals.control_id,
      state: "failed",
      detail: terminalFailure("audit queue dead-lettered", signals.queue_error),
    };
  }
  if (signals.audit_status === "failed") {
    return {
      control_id: signals.control_id,
      state: "failed",
      detail: terminalFailure("audit failed", signals.audit_error),
    };
  }
  if (signals.audit_job_status === "failed") {
    return {
      control_id: signals.control_id,
      state: "failed",
      detail: terminalFailure("audit worker failed", signals.audit_job_error),
    };
  }
  if (signals.audit_job_status === "success" && signals.airtable_writeback_ok === false) {
    return {
      control_id: signals.control_id,
      state: "failed",
      detail: "audit completed, but its Airtable result write failed",
    };
  }

  const airtableComplete = signals.airtable_message?.trim().startsWith("🥳 Audit complete") ??
    false;
  if (
    signals.sync_status === "completed" &&
    signals.audit_status === "completed" &&
    signals.audit_job_status === "success" &&
    signals.airtable_writeback_ok === true &&
    airtableComplete
  ) {
    return {
      control_id: signals.control_id,
      state: "passed",
      detail: "sync, audit, and Airtable result verified",
    };
  }

  if (signals.airtable_read_error) {
    return {
      control_id: signals.control_id,
      state: "pending",
      detail: `waiting to verify Airtable: ${signals.airtable_read_error}`,
    };
  }
  if (signals.sync_status !== "completed") {
    return {
      control_id: signals.control_id,
      state: "pending",
      detail: `evidence sync ${signals.sync_status ?? "not found yet"}`,
    };
  }
  if (signals.audit_status !== "completed") {
    return {
      control_id: signals.control_id,
      state: "pending",
      detail: `audit ${signals.audit_status ?? "not started yet"}`,
    };
  }
  if (signals.audit_job_status !== "success") {
    return {
      control_id: signals.control_id,
      state: "pending",
      detail: `audit worker ${signals.audit_job_status ?? "not started yet"}`,
    };
  }
  return {
    control_id: signals.control_id,
    state: "pending",
    detail: "waiting for Airtable to show Audit complete",
  };
}

export interface RecoveryVerificationSummary {
  total: number;
  passed: number;
  pending: number;
  failed: number;
  checks: RecoveryControlCheck[];
}

export function summarizeRecoveryChecks(
  checks: RecoveryControlCheck[],
): RecoveryVerificationSummary {
  return {
    total: checks.length,
    passed: checks.filter((check) => check.state === "passed").length,
    pending: checks.filter((check) => check.state === "pending").length,
    failed: checks.filter((check) => check.state === "failed").length,
    checks,
  };
}

function controlList(checks: RecoveryControlCheck[]): string {
  return checks.map((check) => check.control_id).join(", ");
}

export function recoveryVerificationMessage(
  summary: RecoveryVerificationSummary,
  timedOut = false,
): string {
  if (summary.failed > 0) {
    const failed = summary.checks.filter((check) => check.state === "failed");
    return `⚠️ Sweep double-check finished — ${summary.passed}/${summary.total} controls look good; ` +
      `${summary.failed} still ${summary.failed === 1 ? "needs" : "need"} attention: ${
        controlList(failed)
      }.`;
  }
  if (timedOut) {
    const pending = summary.checks.filter((check) => check.state === "pending");
    return `⚠️ Sweep double-check timed out — ${summary.passed}/${summary.total} controls look good; ` +
      `${summary.pending} ${summary.pending === 1 ? "is" : "are"} still unfinished: ${
        controlList(pending)
      }.`;
  }
  if (summary.total > 0 && summary.passed === summary.total) {
    return `✅ Sweep complete — double-check passed. All ${summary.total} control${
      summary.total === 1 ? "" : "s"
    } finished successfully and Airtable results are updated.`;
  }
  return `⏳ Sweep double-check: ${summary.passed}/${summary.total} controls complete; ` +
    `${summary.pending} still running.`;
}
