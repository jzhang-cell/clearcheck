import { assertEquals, assertMatch } from "@std/assert";
import { storageObjectFilename } from "./storage-object-name.ts";

Deno.test("safe storage filenames remain readable and unchanged", () => {
  assertEquals(
    storageObjectFilename("Disaster-Recovery-Report.pdf"),
    "Disaster-Recovery-Report.pdf",
  );
});

Deno.test("square brackets are removed from the storage object name", () => {
  const result = storageObjectFilename(
    "Disaster-Recovery-Drill-Report-[NEED-TO-DO-ACTUAL-TEST].pdf",
  );
  assertMatch(result, /^Disaster-Recovery-Drill-Report-NEED-TO-DO-ACTUAL-TEST-[0-9a-f]{8}\.pdf$/);
  assertEquals(result.includes("["), false);
  assertEquals(result.includes("]"), false);
});

Deno.test("different unsafe source names do not collapse onto the same key", () => {
  const bracketed = storageObjectFilename("report[final].pdf");
  const plain = storageObjectFilename("report-final.pdf");
  assertEquals(bracketed === plain, false);
});

Deno.test("path separators cannot create extra object-key segments", () => {
  assertMatch(storageObjectFilename("folder\\nested/report?.pdf"), /^report-[0-9a-f]{8}\.pdf$/);
});
