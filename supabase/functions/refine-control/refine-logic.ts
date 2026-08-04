import { parseClaudeJson } from "../_shared/claude-parse.ts";

export interface RefinedOutput {
  Refined_Expected_Procedure: string;
}

export function parseRefinedExpectedProcedure(raw: string): RefinedOutput {
  // parseClaudeJson handles <scratchpad>, code fences, and bare JSON. The
  // expected-procedure prompt currently emits bare JSON, but the shared parser
  // keeps the function tolerant of harmless model wrapping.
  const { parsed } = parseClaudeJson(raw);
  const refined = parsed.Refined_Expected_Procedure;
  if (typeof refined !== "string" || !refined.trim()) {
    throw new Error(
      `Claude output missing required Refined_Expected_Procedure string. ` +
        `Got keys: ${Object.keys(parsed).join(", ")}`,
    );
  }
  return { Refined_Expected_Procedure: refined.trim() };
}
