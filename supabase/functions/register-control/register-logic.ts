export interface ControlUpsertInput {
  engagementId: string;
  controlId: string;
  updatedAt: string;
  companyControl?: unknown;
  controlDescription?: unknown;
  expectedProcedures?: unknown;
  useProceduresAsProvided?: boolean;
  airtableRecordId?: unknown;
}

// Build the columns written by register-control. Supplying Expected Procedures
// normally invalidates the old refinement. A re-run can explicitly declare the
// current Airtable procedure final; in that mode the same text becomes the audit
// procedure immediately and no AI refinement call is needed. Initial runs keep
// the fail-closed invalidation behavior.
export function buildControlUpsertFields(input: ControlUpsertInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    engagement_id: input.engagementId,
    control_id: input.controlId,
    updated_at: input.updatedAt,
  };

  if (typeof input.companyControl === "string") {
    fields.company_control = input.companyControl;
  }
  if (typeof input.controlDescription === "string") {
    fields.control_description = input.controlDescription;
  }
  if (typeof input.expectedProcedures === "string") {
    fields.expected_procedures = input.expectedProcedures;
    if (input.useProceduresAsProvided) {
      fields.refined_control_description = null;
      fields.refined_expected_procedure = input.expectedProcedures;
      fields.refinement_status = "refined";
      fields.refined_at = input.updatedAt;
    } else {
      fields.refined_expected_procedure = null;
      fields.refinement_status = "pending";
      fields.refined_at = null;
    }
  }
  if (typeof input.airtableRecordId === "string") {
    fields.airtable_record_id = input.airtableRecordId;
  }

  return fields;
}
