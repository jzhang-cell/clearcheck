// Tests for parseAuditResponse tolerance (run-audit verdict parsing).
//   deno test supabase/functions/_shared/claude-parse-audit.test.ts
//
// Covers the "missing required tag(s)" robustness fix: the verdict tags are now
// searched across the WHOLE response, so they parse whether the model put them
// inside the <scratchpad>, after it, or with no wrapper at all. A genuinely
// absent tag still throws.

import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { parseAuditResponse } from "./claude-parse.ts";

const TAGS = `<conformity_level>No Deviation</conformity_level>
<root_cause>None</root_cause>
<determination>The control operated effectively.</determination>
<briefing>Evidence supports the control.</briefing>
<clarifications>None.</clarifications>`;

Deno.test("tags inside the scratchpad (happy path)", () => {
  const r = parseAuditResponse(`<scratchpad>\nreasoning...\n${TAGS}\n</scratchpad>`);
  assertEquals(r.conformity_level, "No Deviation");
  assertEquals(r.conformity_status, "Conforming");
  assertEquals(r.conformity_determination, "The control operated effectively.");
});

Deno.test("tags placed AFTER the scratchpad block (previously failed)", () => {
  const r = parseAuditResponse(`<scratchpad>\nreasoning only...\n</scratchpad>\n${TAGS}`);
  assertEquals(r.conformity_level, "No Deviation");
  assertEquals(r.conformity_status, "Conforming");
  // scratchpad storage still captures the reasoning block
  assertEquals(r.scratchpad.includes("reasoning only"), true);
});

Deno.test("no scratchpad wrapper at all, tags present", () => {
  const r = parseAuditResponse(`Here is my verdict:\n${TAGS}`);
  assertEquals(r.conformity_level, "No Deviation");
  assertEquals(r.root_cause_category, "None");
});

Deno.test("wrapped in a code fence", () => {
  const r = parseAuditResponse("```xml\n<scratchpad>\n" + TAGS + "\n</scratchpad>\n```");
  assertEquals(r.conformity_status, "Conforming");
});

Deno.test("Deviation maps correctly", () => {
  const tags = TAGS.replace("No Deviation", "Deviation");
  const r = parseAuditResponse(`<scratchpad>${tags}</scratchpad>`);
  assertEquals(r.conformity_level, "Deviation");
  assertEquals(r.conformity_status, "Deviation");
});

Deno.test("a genuinely missing tag still throws", () => {
  const tags = TAGS.replace(/<briefing>[\s\S]*?<\/briefing>\n?/, "");
  assertThrows(
    () => parseAuditResponse(`<scratchpad>${tags}</scratchpad>`),
    Error,
    "missing required tag(s): briefing",
  );
});

Deno.test("an unknown conformity_level value throws", () => {
  const tags = TAGS.replace("No Deviation", "Totally Fine");
  assertThrows(
    () => parseAuditResponse(`<scratchpad>${tags}</scratchpad>`),
    Error,
    "Unknown <conformity_level>",
  );
});
