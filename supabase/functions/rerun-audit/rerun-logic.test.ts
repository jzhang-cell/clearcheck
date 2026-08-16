import { assertEquals } from "@std/assert";
import { assertStringIncludes } from "@std/assert";
import {
  additionalEvidenceFailureMessage,
  hasRerunScopeChanged,
  parseRerunScopeInput,
} from "./rerun-logic.ts";

Deno.test("re-run scope uses the supplied description and procedures without refinement", () => {
  const result = parseRerunScopeInput(
    "  Access is reviewed quarterly.  ",
    "  Inspected the quarterly access review.  ",
  );

  assertEquals(result, {
    ok: true,
    controlDescription: "Access is reviewed quarterly.",
    expectedProcedures: "Inspected the quarterly access review.",
  });
});

Deno.test("re-run scope requires both supplied inputs", () => {
  assertEquals(parseRerunScopeInput("Access is reviewed quarterly.", "  "), {
    ok: false,
    error: "Missing or empty 'control_description' or 'expected_procedures'",
  });
});

Deno.test("scope changes when an old inspection procedure is removed", () => {
  assertEquals(
    hasRerunScopeChanged({
      providedControlDescription: "Customer support issues use relevant channels.",
      providedExpectedProcedures: "Inquired of management about the communication channels.",
      storedControlDescription: "Customer support issues use relevant channels.",
      storedExpectedProcedures:
        "Inquired of management about the communication channels.\n\nInspected the company website.",
    }),
    true,
  );
});

Deno.test("scope comparison ignores whitespace and case only", () => {
  assertEquals(
    hasRerunScopeChanged({
      providedControlDescription: "Customer Support Issues",
      providedExpectedProcedures: "Inquired  of management.",
      storedControlDescription: " customer support issues ",
      storedExpectedProcedures: "inquired of management.",
    }),
    false,
  );
});

Deno.test("failed additional evidence blocks the remediation audit with file details", () => {
  const result = additionalEvidenceFailureMessage([
    { filename: "policy.pdf", reason: "Storage upload failed: Invalid key" },
  ], 3);

  assertStringIncludes(result.status, "1/3 file failed");
  assertStringIncludes(result.status, "Audit was not started");
  assertStringIncludes(result.status, "policy.pdf");
  assertStringIncludes(result.error, "Invalid key");
});
