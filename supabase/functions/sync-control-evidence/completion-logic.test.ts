import { assertEquals, assertStringIncludes } from "@std/assert";
import { evidenceCompletionOutcome, reconcileFailedFilenames } from "./completion-logic.ts";

Deno.test("a known partial source blocks the audit even when some evidence is ready", () => {
  const result = evidenceCompletionOutcome({
    uniqueReady: 4,
    sourceFiles: 5,
    failed: 1,
    zipFiles: [],
    failureReasons: "document extraction timed out",
  });
  assertEquals(result.auditReady, false);
  assertStringIncludes(result.statusMessage, "Evidence incomplete");
  assertStringIncludes(result.statusMessage, "Audit was not started");
});

Deno.test("exact-content duplicates do not block a complete sync", () => {
  const result = evidenceCompletionOutcome({
    uniqueReady: 1,
    sourceFiles: 2,
    failed: 0,
    zipFiles: [],
    failureReasons: "",
  });
  assertEquals(result.auditReady, true);
  assertStringIncludes(result.statusMessage, "reused identical evidence");
});

Deno.test("mixed zip evidence blocks a partial audit", () => {
  const result = evidenceCompletionOutcome({
    uniqueReady: 2,
    sourceFiles: 3,
    failed: 0,
    zipFiles: ["screenshots.zip"],
    failureReasons: "",
  });
  assertEquals(result.auditReady, false);
  assertStringIncludes(result.statusMessage, "must be unzipped");
});

Deno.test("late extraction completion clears a carried timeout failure", () => {
  assertEquals(
    reconcileFailedFilenames(
      ["slow.pdf", "broken.pdf", "slow.pdf"],
      new Set(["slow.pdf", "ready.pdf"]),
    ),
    { unresolved: ["broken.pdf"], resolvedLate: ["slow.pdf"] },
  );
});
