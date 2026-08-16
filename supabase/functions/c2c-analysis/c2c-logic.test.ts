import { assertEquals, assertThrows } from "@std/assert";
import {
  airtableCellText,
  buildAirtableControlFields,
  formatOwnerValue,
  linkedRecordIds,
  parseC2CResults,
  parseClientControlCsv,
  validateC2CResultSet,
} from "./c2c-logic.ts";

Deno.test("parses aliased client-control columns and ignores evidence continuation rows", () => {
  const csv = [
    "Baseline Control ID,Description,TSC Criteria,Control Owner,Expected Evidence",
    'CC.01.01,"Board meets, annually","CC1.1, CC1.2",Alex,Invitation',
    ",,,,Minutes",
    "CC.01.02,Management meets weekly,CC2.2,Alex,Notes",
  ].join("\n");

  const parsed = parseClientControlCsv(csv);
  assertEquals(parsed.columns, {
    control_id: "Baseline Control ID",
    control_description: "Description",
    criteria: "TSC Criteria",
    owner: "Control Owner",
  });
  assertEquals(parsed.controls, [
    {
      control_id: "CC.01.01",
      control_description: "Board meets, annually",
      criteria: ["CC1.1", "CC1.2"],
      owner: "Alex",
      source_row: 2,
    },
    {
      control_id: "CC.01.02",
      control_description: "Management meets weekly",
      criteria: ["CC2.2"],
      owner: "Alex",
      source_row: 4,
    },
  ]);
});

Deno.test("rejects duplicate control IDs before any Airtable write", () => {
  const csv = [
    "Control ID,Control Description,Criteria,Owner",
    "CC.01.01,First,CC1.1,Alex",
    "cc.01.01,Second,CC1.2,Alex",
  ].join("\n");
  assertThrows(() => parseClientControlCsv(csv), Error, "Duplicate Control ID");
});

Deno.test("normalizes linked records, lookup text, and owner select values", () => {
  assertEquals(linkedRecordIds(["recA", { id: "recB", name: "B" }, null]), ["recA", "recB"]);
  assertEquals(airtableCellText(["First", { name: "Second" }]), "First\nSecond");
  assertEquals(formatOwnerValue("Alex", "singleSelect"), { name: "Alex" });
  assertEquals(formatOwnerValue("Alex", "multipleSelects"), [{ name: "Alex" }]);
  assertEquals(formatOwnerValue("Alex", "singleLineText"), "Alex");
});

Deno.test("maps the CSV control ID into both Airtable control ID fields", () => {
  assertEquals(
    buildAirtableControlFields({
      control: {
        control_id: "CC.01.01",
        control_description: "The board reviews security annually.",
        criteria: ["CC1.1"],
        owner: "Alex",
        source_row: 2,
      },
      baselineRecordId: "recBaseline",
      tscRecordIds: ["recCriteria"],
      ownerFieldType: "singleSelect",
      overviewRecordId: "recbN7FPFFMr3KxRw",
    }),
    {
      "Control ID": "CC.01.01",
      "Baseline Control ID": ["recBaseline"],
      "Control Description": "The board reviews security annually.",
      "TSC Criteria": ["recCriteria"],
      "Owner": { name: "Alex" },
      "Overview": ["recbN7FPFFMr3KxRw"],
    },
  );
});

Deno.test("parses and validates the exact C2C output contract", () => {
  const results = parseC2CResults(JSON.stringify({
    results: [
      {
        control_id: "CC.01.01",
        change_type: "No difference",
        baseline_change_suggestion: "CC.01.01\nNo difference: Equivalent meaning.",
      },
      {
        control_id: "CC.01.02",
        change_type: "🚨 Substantive change",
        baseline_change_suggestion: "CC.01.02\nSubstantive change: Weekly review was removed.",
      },
    ],
  }));
  validateC2CResultSet(results, ["CC.01.01", "CC.01.02"]);
  assertEquals(results.map((result) => result.change_type), [
    "✅ No difference",
    "🚨 Substantive change",
  ]);
});

Deno.test("rejects missing or extra Claude result IDs", () => {
  const results = parseC2CResults(JSON.stringify({
    results: [{
      control_id: "CC.99.99",
      change_type: "Editorial change",
      baseline_change_suggestion: "CC.99.99\nEditorial change: Wording only.",
    }],
  }));
  assertThrows(
    () => validateC2CResultSet(results, ["CC.01.01"]),
    Error,
    "missing: CC.01.01; unexpected: CC.99.99",
  );
});
