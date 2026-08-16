const INSPECTION_VERB =
  /\b(?:inspect(?:ed|ing)?|examin(?:ed|ing)?|observ(?:ed|ing)?|review(?:ed|ing)?|obtain(?:ed|ing)?|select(?:ed|ing)?|recalculat(?:ed|ing)?|trac(?:ed|ing)?)\b/gi;

const NUMBERED_INSPECTION_SECTION =
  /^\d+\.\s+(?:inspect(?:ed|ing)?|examin(?:ed|ing)?|observ(?:ed|ing)?|review(?:ed|ing)?|obtain(?:ed|ing)?|select(?:ed|ing)?|recalculat(?:ed|ing)?|trac(?:ed|ing)?)\b/gim;

export interface WorkpaperScopeCheck {
  ok: boolean;
  expectedInspectionSteps: number;
  renderedInspectionSections: number;
}

// This is a fail-closed structural guard, not a semantic judge. The renderer may
// consolidate current procedures, but it may never invent more inspection
// sections than the current Expected Procedures contain.
export function checkWorkpaperScope(
  expectedProcedures: string,
  renderedMarkdown: string,
): WorkpaperScopeCheck {
  const expectedInspectionSteps = [...expectedProcedures.matchAll(INSPECTION_VERB)].length;
  const renderedInspectionSections = [...renderedMarkdown.matchAll(NUMBERED_INSPECTION_SECTION)]
    .length;
  return {
    ok: renderedInspectionSections <= expectedInspectionSteps,
    expectedInspectionSteps,
    renderedInspectionSections,
  };
}

export function scopeSafeWorkpaperFallback(
  noDeviation: boolean,
  determination: string,
): string {
  if (noDeviation) return "1. No deviations noted.";

  const narrative = determination
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return `1. Deviations noted:\n- ${narrative || "The current procedure was not satisfied."}`;
}
