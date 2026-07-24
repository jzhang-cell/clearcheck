// deno-lint-ignore-file no-import-prefix -- matches the repository's existing test imports.
import { assertEquals } from "jsr:@std/assert@^1";
import {
  jobPayloadMatchesControls,
  matchBadControls,
  normalizeBadControlIds,
  type RecoverableControl,
  sweepingStatus,
} from "./recovery-logic.ts";

const controls: RecoverableControl[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    control_id: "CC.01.01",
    airtable_record_id: "recControlOne",
    engagement_id: "eng-1",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    control_id: "CC.02.02",
    airtable_record_id: "recControlTwo",
    engagement_id: "eng-1",
  },
];

Deno.test("normalizes Airtable lookup arrays and de-duplicates identifiers", () => {
  assertEquals(
    normalizeBadControlIds([
      { id: "recControlOne" },
      { id: "recControlTwo" },
      "RECCONTROLONE",
      null,
    ]),
    ["recControlOne", "recControlTwo"],
  );
});

Deno.test("normalizes JSON and rollup strings", () => {
  assertEquals(
    normalizeBadControlIds('["CC.01.01", "CC.02.02"]'),
    ["CC.01.01", "CC.02.02"],
  );
  assertEquals(
    normalizeBadControlIds("CC.01.01, CC.02.02\nrecControlOne"),
    ["CC.01.01", "CC.02.02", "recControlOne"],
  );
});

Deno.test("matches UUIDs, control codes, and Airtable record IDs", () => {
  const matched = matchBadControls(
    ["CC.01.01", "recControlTwo", "missing", "11111111-1111-4111-8111-111111111111"],
    controls,
  );
  assertEquals(matched.controls.map((control) => control.control_id), ["CC.01.01", "CC.02.02"]);
  assertEquals(matched.unmatched, ["missing"]);
});

Deno.test("renders the requested overview progress message", () => {
  assertEquals(sweepingStatus(1), "🧹 Sweeping the total 1 job.");
  assertEquals(sweepingStatus(3), "🧹 Sweeping the total 3 jobs.");
});

Deno.test("matches stale per-file jobs whose UUID is stored as control_id", () => {
  assertEquals(
    jobPayloadMatchesControls(
      { control_id: "11111111-1111-4111-8111-111111111111", filename: "evidence.pdf" },
      controls,
    ),
    true,
  );
  assertEquals(jobPayloadMatchesControls({ control_uuid: "missing" }, controls), false);
});
