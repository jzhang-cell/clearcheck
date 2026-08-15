export interface EvidenceCompletionInput {
  uniqueReady: number;
  sourceFiles: number;
  failed: number;
  zipFiles: string[];
  failureReasons: string;
}

export interface EvidenceCompletionOutcome {
  auditReady: boolean;
  statusMessage: string;
  errorMessage: string | null;
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

// A full sync must never launch an audit over a known-partial current source.
// Exact-content dedupe is not a failure: `uniqueReady` may legitimately be less
// than `sourceFiles`, so failed/unsupported inputs are tracked explicitly.
export function evidenceCompletionOutcome(
  input: EvidenceCompletionInput,
): EvidenceCompletionOutcome {
  const readyLabel = `${input.uniqueReady} unique evidence file${plural(input.uniqueReady)} linked`;
  const sourceLabel = `${input.sourceFiles} file${plural(input.sourceFiles)} in the current source`;
  const hasFailures = input.failed > 0;
  const hasZips = input.zipFiles.length > 0;

  if (input.uniqueReady === 0) {
    if (hasZips && !hasFailures) {
      const statusMessage = `📦 Only zip file${plural(input.zipFiles.length)} found ` +
        `(${input.zipFiles.join(", ")}). Please unzip and re-upload before running the audit.`;
      return {
        auditReady: false,
        statusMessage,
        errorMessage: `No usable evidence — only zip file(s): ${input.zipFiles.join(", ")}`,
      };
    }

    const statusMessage =
      `❌ Evidence could not be processed (${input.failed} file${plural(input.failed)} failed). ` +
      (input.failureReasons
        ? `Reason: ${input.failureReasons}`
        : "Check the source files and re-run.");
    return {
      auditReady: false,
      statusMessage,
      errorMessage: `No usable evidence — ${input.failed} file(s) failed. Reasons: ${
        input.failureReasons || "(none captured)"
      }`,
    };
  }

  if (hasFailures || hasZips) {
    let statusMessage = `⚠️ Evidence incomplete — ${readyLabel}; ${sourceLabel}.`;
    if (hasFailures) {
      statusMessage += ` ${input.failed} file${plural(input.failed)} failed.`;
    }
    if (hasZips) {
      statusMessage += ` ${input.zipFiles.length} zip file${plural(input.zipFiles.length)} ` +
        `must be unzipped: ${input.zipFiles.join(", ")}.`;
    }
    if (input.failureReasons) statusMessage += ` Reason: ${input.failureReasons}`;
    statusMessage += " Audit was not started; fix the listed files and re-run.";

    return {
      auditReady: false,
      statusMessage,
      errorMessage: [
        `Partial evidence sync blocked audit: ${input.failed} failed, ` +
        `${input.zipFiles.length} zip, ${input.uniqueReady} unique ready of ` +
        `${input.sourceFiles} source files.`,
        input.failureReasons,
      ].filter(Boolean).join(" "),
    };
  }

  const duplicateNote = input.uniqueReady < input.sourceFiles
    ? ` ${input.sourceFiles - input.uniqueReady} submitted file${
      plural(input.sourceFiles - input.uniqueReady)
    } reused identical evidence and was stored once.`
    : "";
  return {
    auditReady: true,
    statusMessage: `✅ Evidence ready — ${readyLabel}; ${sourceLabel}.${duplicateNote}`,
    errorMessage: null,
  };
}

export function reconcileFailedFilenames(
  failedNames: Iterable<string>,
  readyNames: ReadonlySet<string>,
): { unresolved: string[]; resolvedLate: string[] } {
  const unresolved: string[] = [];
  const resolvedLate: string[] = [];
  for (const name of new Set(failedNames)) {
    if (readyNames.has(name)) resolvedLate.push(name);
    else unresolved.push(name);
  }
  return { unresolved, resolvedLate };
}
