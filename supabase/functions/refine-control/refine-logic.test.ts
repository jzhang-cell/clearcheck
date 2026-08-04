import { assertEquals, assertThrows } from "@std/assert";
import { parseRefinedExpectedProcedure } from "./refine-logic.ts";

Deno.test("expected-procedure refinement no longer requires a polished description", () => {
  assertEquals(
    parseRefinedExpectedProcedure(JSON.stringify({
      Refined_Expected_Procedure: "Inspected the policy to determine whether it was approved.",
    })),
    {
      Refined_Expected_Procedure: "Inspected the policy to determine whether it was approved.",
    },
  );
});

Deno.test("expected-procedure refinement rejects the removed description-only output", () => {
  assertThrows(
    () =>
      parseRefinedExpectedProcedure(JSON.stringify({
        Suggested_Control_Description: "A polished description.",
      })),
    Error,
    "missing required Refined_Expected_Procedure",
  );
});
