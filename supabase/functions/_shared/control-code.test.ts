// deno-lint-ignore-file no-import-prefix -- matches the repository's existing test imports.
import { assertEquals } from "jsr:@std/assert@^1";
import { controlCodesEqual, normalizeControlCode } from "./control-code.ts";

Deno.test("removes invisible Airtable import characters from control codes", () => {
  assertEquals(normalizeControlCode("CC.01.01\uFEFF"), "CC.01.01");
  assertEquals(normalizeControlCode(" \u200BCC.01.01\u2060 "), "CC.01.01");
});

Deno.test("matches a clean Drive folder prefix to a contaminated control code", () => {
  assertEquals(controlCodesEqual("CC.01.01", "CC.01.01\uFEFF"), true);
  assertEquals(controlCodesEqual("CC.01.02", "CC.01.01\uFEFF"), false);
});
