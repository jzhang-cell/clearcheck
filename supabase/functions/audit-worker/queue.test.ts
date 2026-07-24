// Unit tests for the audit-worker's queue decisions (queue-logic.ts).
// Pure logic, no DB/Airtable needed. Run from the repo root:
//   deno test supabase/functions/audit-worker/queue.test.ts
//
// These cover the safety-critical bits: the spent-attempts dead-letter gate
// (don't burn a 4th Opus call on a deterministic failure), the outcome
// classification (what retries vs what can never succeed), the backoff shape,
// and the auditor-facing dead-letter message.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { classifyOutcome, deadLetterMessage, isSpent, retryDelayMs } from "./queue-logic.ts";

Deno.test("isSpent: claims within the cap may run", () => {
  assertEquals(isSpent(1, 3), false);
  assertEquals(isSpent(2, 3), false);
  assertEquals(isSpent(3, 3), false);
});

Deno.test("isSpent: a claim beyond the cap dead-letters instead of running", () => {
  assertEquals(isSpent(4, 3), true);
  assertEquals(isSpent(10, 3), true);
});

Deno.test("classifyOutcome: success is done", () => {
  assertEquals(classifyOutcome(true, 200), "done");
});

Deno.test("classifyOutcome: 404/403 can never succeed — dead", () => {
  assertEquals(classifyOutcome(false, 404), "dead"); // control deleted
  assertEquals(classifyOutcome(false, 403), "dead"); // cross-engagement mismatch
});

Deno.test("classifyOutcome: transient/preflight failures retry", () => {
  assertEquals(classifyOutcome(false, 500), "retry"); // pipeline blew up
  assertEquals(classifyOutcome(false, 400), "retry"); // refinement may still catch up
});

Deno.test("retryDelayMs: grows per attempt and caps", () => {
  assertEquals(retryDelayMs(1), 2 * 60_000);
  assertEquals(retryDelayMs(2), 4 * 60_000);
  assertEquals(retryDelayMs(3), 8 * 60_000);
  assertEquals(retryDelayMs(10), 15 * 60_000); // capped
});

Deno.test("retryDelayMs: nonsense attempts still yield a sane floor", () => {
  assertEquals(retryDelayMs(0), 2 * 60_000);
  assertEquals(retryDelayMs(-5), 2 * 60_000);
});

Deno.test("deadLetterMessage: actionable, includes attempts + truncated reason", () => {
  const msg = deadLetterMessage(3, "boom ".repeat(60));
  assertStringIncludes(msg, "after 3 attempts");
  assertStringIncludes(msg, "press Re-run");
  assertStringIncludes(msg, "…"); // long reason truncated
  assertEquals(msg.length < 400, true);
});

Deno.test("deadLetterMessage: no reason → no dangling 'Last error'", () => {
  const msg = deadLetterMessage(1, null);
  assertStringIncludes(msg, "after 1 attempt —");
  assertEquals(msg.includes("Last error"), false);
});
