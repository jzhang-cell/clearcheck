import { assertEquals } from "@std/assert";
import { checkWorkpaperScope, scopeSafeWorkpaperFallback } from "./workpaper-scope.ts";

Deno.test("inquiry-only procedures reject an invented inspection section", () => {
  const check = checkWorkpaperScope(
    "Inquired of management to determine customer support issues use relevant channels.",
    [
      "1. Deviations noted:",
      "- Evidence was not sufficient.",
      "",
      "2. Inspected the company website where the following was noted:",
      "- No website artifact was provided.",
    ].join("\n"),
  );

  assertEquals(check, {
    ok: false,
    expectedInspectionSteps: 0,
    renderedInspectionSections: 1,
  });
});

Deno.test("rendered inspection sections may not exceed current procedures", () => {
  const check = checkWorkpaperScope(
    "Inspected the support policy.\n\nReviewed one complaint ticket.",
    "1. No deviations noted.\n\n2. Inspected the support policy where the following was noted:",
  );
  assertEquals(check.ok, true);
  assertEquals(check.expectedInspectionSteps, 2);
  assertEquals(check.renderedInspectionSections, 1);
});

Deno.test("scope-safe fallback never creates a second numbered section", () => {
  assertEquals(
    scopeSafeWorkpaperFallback(false, "The current inquiry response was not sufficient."),
    "1. Deviations noted:\n- The current inquiry response was not sufficient.",
  );
});
