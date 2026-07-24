// Pure progress helpers for sync-control-evidence.
//
// A completed worker result is not necessarily audit-ready: large PDFs return
// `queued` as soon as Make accepts them, while failed files and skipped ZIPs
// also return a settled result. Only extracted files and completed dedupe hits
// may advance the "files ready" count.

export interface EvidenceProgressResult {
  status: "extracted" | "skipped" | "queued" | "failed";
  skip_reason?: string;
}

export interface EvidenceProgress {
  handled: number;
  ready: number;
  queuedExternal: number;
  failed: number;
}

export function summarizeEvidenceProgress(
  readyBefore: number,
  results: EvidenceProgressResult[],
): EvidenceProgress {
  let readyThisRun = 0;
  let queuedExternal = 0;
  let failed = 0;

  for (const result of results) {
    if (result.status === "extracted" || (result.status === "skipped" && result.skip_reason)) {
      readyThisRun++;
    } else if (result.status === "queued") {
      queuedExternal++;
    } else if (result.status === "failed") {
      failed++;
    }
  }

  return {
    handled: readyBefore + results.length,
    ready: readyBefore + readyThisRun,
    queuedExternal,
    failed,
  };
}

const PROGRESS_SEGMENTS = 10;

export function evidenceProgressMessage(progress: EvidenceProgress, total: number): string {
  const filled = total > 0
    ? Math.min(PROGRESS_SEGMENTS, Math.round((progress.ready / total) * PROGRESS_SEGMENTS))
    : 0;
  const bar = "🟩".repeat(filled) + "⬜".repeat(PROGRESS_SEGMENTS - filled);

  let label: string;
  if (progress.queuedExternal > 0) {
    label = `☁️ ${progress.queuedExternal} large PDF${
      progress.queuedExternal === 1 ? "" : "s"
    } sent to Make…`;
  } else if (progress.ready >= total && total > 0) {
    label = "✅ Evidence ready — preparing the audit…";
  } else {
    label = "📄 Reading your evidence…";
  }

  return `${label} ${bar}  ${progress.ready} of ${total} files ready`;
}
