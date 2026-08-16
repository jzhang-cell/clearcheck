import { assertEquals } from "@std/assert";
import { buildControlUpsertFields } from "./register-logic.ts";

Deno.test("new Expected Procedures invalidate the prior refined procedure", () => {
  const expectedProcedures = [
    "Inspected the backup configuration.",
    "Inspected the backup monitoring log.",
    "Inspected a restoration test.",
  ].join("\n\n");
  const fields = buildControlUpsertFields({
    engagementId: "engagement-1",
    controlId: "CC.01.01",
    updatedAt: "2026-08-06T12:00:00.000Z",
    expectedProcedures,
  });

  assertEquals(fields.expected_procedures, expectedProcedures);
  assertEquals(fields.refined_expected_procedure, null);
  assertEquals(fields.refinement_status, "pending");
  assertEquals(fields.refined_at, null);
});

Deno.test("omitting Expected Procedures preserves the existing refinement", () => {
  const fields = buildControlUpsertFields({
    engagementId: "engagement-1",
    controlId: "CC.01.01",
    updatedAt: "2026-08-06T12:00:00.000Z",
    controlDescription: "Backups are tested through data restoration checks.",
  });

  assertEquals("expected_procedures" in fields, false);
  assertEquals("refined_expected_procedure" in fields, false);
  assertEquals("refinement_status" in fields, false);
  assertEquals("refined_at" in fields, false);
});

Deno.test("a re-run can use Expected Procedures exactly as provided", () => {
  const expectedProcedures = "Inspected the approved access review and retained evidence.";
  const updatedAt = "2026-08-07T04:00:00.000Z";
  const fields = buildControlUpsertFields({
    engagementId: "engagement-1",
    controlId: "CC.01.01",
    updatedAt,
    expectedProcedures,
    useProceduresAsProvided: true,
  });

  assertEquals(fields.expected_procedures, expectedProcedures);
  assertEquals(fields.refined_control_description, null);
  assertEquals(fields.refined_expected_procedure, expectedProcedures);
  assertEquals(fields.refinement_status, "refined");
  assertEquals(fields.refined_at, updatedAt);
});
