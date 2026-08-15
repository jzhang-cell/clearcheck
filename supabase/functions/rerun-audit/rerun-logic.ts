export type RerunScopeInput =
  | { ok: true; controlDescription: string; expectedProcedures: string }
  | { ok: false; error: string };

// Re-runs use the current Airtable scope exactly as supplied. They deliberately
// do not depend on, or regenerate, the control's stored AI-refined procedure.
export function parseRerunScopeInput(
  controlDescription: unknown,
  expectedProcedures: unknown,
): RerunScopeInput {
  const description = typeof controlDescription === "string" ? controlDescription.trim() : "";
  const procedures = typeof expectedProcedures === "string" ? expectedProcedures.trim() : "";

  if (!description || !procedures) {
    return {
      ok: false,
      error: "Missing or empty 'control_description' or 'expected_procedures'",
    };
  }

  return {
    ok: true,
    controlDescription: description,
    expectedProcedures: procedures,
  };
}

function normalizeScopeText(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

// A changed scope makes the old narrative unsafe context: it may name testing
// steps or requested artifacts that the auditor deliberately removed.
export function hasRerunScopeChanged(args: {
  providedControlDescription: string;
  providedExpectedProcedures: string;
  storedControlDescription: string | null;
  storedExpectedProcedures: string | null;
}): boolean {
  return normalizeScopeText(args.providedControlDescription) !==
      normalizeScopeText(args.storedControlDescription) ||
    normalizeScopeText(args.providedExpectedProcedures) !==
      normalizeScopeText(args.storedExpectedProcedures);
}

export interface AdditionalEvidenceFailure {
  filename: string;
  reason: string;
}

export function additionalEvidenceFailureMessage(
  failures: AdditionalEvidenceFailure[],
  totalFiles: number,
): { status: string; error: string } {
  const unique = [...new Map(
    failures.map((failure) => [
      `${failure.filename}\u0000${failure.reason}`,
      failure,
    ]),
  ).values()];
  const details = unique
    .map(({ filename, reason }) => `${filename}: ${reason}`)
    .join(" | ");
  const count = unique.length;
  const status = `❌ Additional evidence incomplete — ${count}/${totalFiles} file${
    count === 1 ? "" : "s"
  } failed. Audit was not started. ${details}`;
  return {
    status,
    error: `Additional evidence ingestion failed for ${count}/${totalFiles} files: ${details}`,
  };
}
