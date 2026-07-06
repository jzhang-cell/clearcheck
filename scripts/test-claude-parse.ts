// Unit-style tests for parseClaudeJson. Run with:
//   deno run --allow-read scripts/test-claude-parse.ts

import { parseClaudeJson } from "../supabase/functions/_shared/claude-parse.ts";

interface TestCase {
  name: string;
  input: string;
  expectScratchpad: string | null;
  expectParsed: Record<string, unknown>;
}

const cases: TestCase[] = [
  {
    name: "1. just JSON",
    input: `{"foo": "bar", "n": 1}`,
    expectScratchpad: null,
    expectParsed: { foo: "bar", n: 1 },
  },
  {
    name: "2. ```json fences + JSON",
    input: '```json\n{"foo": "bar"}\n```',
    expectScratchpad: null,
    expectParsed: { foo: "bar" },
  },
  {
    name: "3. <scratchpad> + JSON",
    input: `<scratchpad>chain of thought</scratchpad>\n{"foo": "bar"}`,
    expectScratchpad: "chain of thought",
    expectParsed: { foo: "bar" },
  },
  {
    name: "4. ```xml outer + ```json inner + JSON (image-(16) pattern)",
    input:
      '```xml\n```json\n{"foo": "bar"}\n```\n```',
    expectScratchpad: null,
    expectParsed: { foo: "bar" },
  },
  {
    name: "5. <scratchpad> + ```xml + ```json + JSON (combined)",
    input:
      `<scratchpad>chain of thought</scratchpad>\n` +
      '```xml\n```json\n{"foo": "bar"}\n```\n```',
    expectScratchpad: "chain of thought",
    expectParsed: { foo: "bar" },
  },
  // Existing/regression cases worth keeping
  {
    name: "6. ```markdown outer + ```json inner + JSON",
    input: '```markdown\n```json\n{"x": 1}\n```\n```',
    expectScratchpad: null,
    expectParsed: { x: 1 },
  },
  {
    name: "7. realistic scratchpad with markdown body + JSON",
    input:
      `<scratchpad>\n## PART A: OCR EXTRACTION\nThis is a screenshot...\n</scratchpad>\n` +
      `{"document_summary": "meeting notes", "extracted": true}`,
    expectScratchpad: "## PART A: OCR EXTRACTION\nThis is a screenshot...",
    expectParsed: { document_summary: "meeting notes", extracted: true },
  },
  {
    name: "8. empty scratchpad + JSON",
    input: `<scratchpad></scratchpad>\n{"foo": "bar"}`,
    expectScratchpad: null,
    expectParsed: { foo: "bar" },
  },
  {
    name: "9. nested JSON object preserved",
    input:
      `<scratchpad>x</scratchpad>\n` +
      '```json\n{"outer": {"inner": {"deep": [1, 2, 3]}}, "scalar": "y"}\n```',
    expectScratchpad: "x",
    expectParsed: { outer: { inner: { deep: [1, 2, 3] } }, scalar: "y" },
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  try {
    const got = parseClaudeJson(c.input);
    const sameScratchpad = got.scratchpad === c.expectScratchpad;
    const sameParsed = JSON.stringify(got.parsed) === JSON.stringify(c.expectParsed);
    if (sameScratchpad && sameParsed) {
      console.log(`PASS  ${c.name}`);
      pass++;
    } else {
      console.log(`FAIL  ${c.name}`);
      if (!sameScratchpad) {
        console.log(`  scratchpad expected: ${JSON.stringify(c.expectScratchpad)}`);
        console.log(`  scratchpad got:      ${JSON.stringify(got.scratchpad)}`);
      }
      if (!sameParsed) {
        console.log(`  parsed expected: ${JSON.stringify(c.expectParsed)}`);
        console.log(`  parsed got:      ${JSON.stringify(got.parsed)}`);
      }
      fail++;
    }
  } catch (err) {
    console.log(`FAIL  ${c.name} (threw): ${(err as Error).message.slice(0, 200)}`);
    fail++;
  }
}

console.log(`\n${pass}/${cases.length} passed, ${fail} failed`);
Deno.exit(fail > 0 ? 1 : 0);
