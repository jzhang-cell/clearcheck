// deno-lint-ignore-file no-import-prefix -- matches the repository's existing test imports.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { evidenceProgressMessage, summarizeEvidenceProgress } from "./progress-logic.ts";

Deno.test("queued Make jobs do not count as evidence ready", () => {
  const progress = summarizeEvidenceProgress(0, [
    { status: "extracted" },
    { status: "queued" },
    { status: "extracted" },
    { status: "queued" },
    { status: "failed" },
    { status: "skipped" },
  ]);

  assertEquals(progress, {
    handled: 6,
    ready: 2,
    queuedExternal: 2,
    failed: 1,
  });
  const message = evidenceProgressMessage(progress, 6);
  assertStringIncludes(message, "2 large PDFs sent to Make");
  assertStringIncludes(message, "2 of 6 files ready");
  assertEquals(message.includes("preparing the audit"), false);
});

Deno.test("completed dedupe hits count as ready evidence", () => {
  const progress = summarizeEvidenceProgress(2, [
    { status: "skipped", skip_reason: "file_dedupe" },
    { status: "skipped", skip_reason: "extraction_dedupe" },
  ]);
  assertEquals(progress.ready, 4);
  assertEquals(progress.handled, 4);
});

Deno.test("audit preparation appears only when every file is actually ready", () => {
  const progress = summarizeEvidenceProgress(1, [
    { status: "extracted" },
    { status: "extracted" },
  ]);
  const message = evidenceProgressMessage(progress, 3);
  assertStringIncludes(message, "Evidence ready — preparing the audit");
  assertStringIncludes(message, "3 of 3 files ready");
});
