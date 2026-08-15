// c2c-analysis — imports one client control CSV from Google Drive into Airtable,
// then compares each client description with its linked baseline description.
//
// Trigger: Airtable automation on Audit Overview field "C2C Analysis".
// Auth: per-engagement key. The key resolves the engagement, Airtable base/row,
// and Google Drive root; no tenant identifiers are trusted from the request.
//
// The Airtable script supplies only linked-table metadata that Airtable already
// knows locally. The server resolves linked records, upserts controls by their
// Baseline Control ID link, calls Claude in bounded batches, and writes the two
// requested analysis fields back to those same rows.

import { resolveEngagementByKey } from "../_shared/auth.ts";
import { callClaude } from "../_shared/claude-client.ts";
import { assertNotTruncated } from "../_shared/claude-parse.ts";
import {
  driveDownload,
  driveList,
  FOLDER_MIME,
  getDriveAccessToken,
} from "../_shared/drive-client.ts";
import { completeJobRun, failJobRun, startJobRun } from "../_shared/job-run.ts";
import { loadActivePrompt } from "../_shared/load-prompt.ts";
import { renderTemplate } from "../_shared/render-template.ts";
import { fetchWithRetry } from "../_shared/retry.ts";
import { withEngagementScope } from "../_shared/scoped-db.ts";
import {
  type AirtableRecord,
  listAirtableRecords,
  patchAirtableRecord,
} from "../_shared/airtable.ts";
import {
  airtableCellText,
  buildAirtableControlFields,
  type C2CComparisonInput,
  type C2CResult,
  type ClientControl,
  linkedRecordIds,
  normalizeRecordKey,
  parseC2CResults,
  parseClientControlCsv,
  validateC2CResultSet,
} from "./c2c-logic.ts";

const FUNCTION_NAME = "c2c-analysis";
const PROMPT_KEY = "c2c_analysis";
const AIRTABLE_OVERVIEW_TABLE_ID = "tblrb4PpeCCIShcnl";
const AIRTABLE_OVERVIEW_RECORD_ID = "recbN7FPFFMr3KxRw";
const AIRTABLE_CONTROLS_TABLE_ID = "tblZrxDzOKd9FJkbC";
const CLIENT_CONTROL_FOLDER = "Client Control";
const AIRTABLE_BATCH_SIZE = 10;
const configuredAiBatchSize = Number(Deno.env.get("C2C_AI_BATCH_SIZE") ?? "20");
const AI_BATCH_SIZE = Number.isFinite(configuredAiBatchSize) && configuredAiBatchSize > 0
  ? Math.min(40, Math.floor(configuredAiBatchSize))
  : 20;

const FIELDS = {
  baselineControlId: "Baseline Control ID",
  controlDescription: "Control Description",
  baselineDescription: "Control Description (Baseline)",
  tscCriteria: "TSC Criteria",
  owner: "Owner",
  changeType: "Baseline Change Type",
  changeSuggestion: "Baseline Change Suggestion",
} as const;

interface RequestPayload {
  baseline_table_id: string;
  baseline_match_field: string;
  tsc_table_id: string;
  tsc_match_field: string;
  owner_field_type?: string;
  trigger_source?: string;
}

interface EngagementContext {
  google_drive_id: string | null;
  airtable_base: string | null;
  airtable_record_id: string | null;
}

interface AirtableWriteRecord {
  id?: string;
  fields: Record<string, unknown>;
}

interface ResolvedControl {
  source: ClientControl;
  baseline_record_id: string;
  tsc_record_ids: string[];
  airtable_record_id?: string;
}

interface ComparisonTarget {
  airtable_record_id: string;
  input: C2CComparisonInput;
}

interface AnalysisSummary {
  csv_file: string;
  controls: number;
  created: number;
  updated: number;
  analyzed: number;
  prompt_id: string;
  prompt_version: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

class VisibleC2CError extends Error {
  constructor(public readonly visibleMessage: string, detail?: string) {
    super(detail ?? visibleMessage);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requireString(payload: RequestPayload, field: keyof RequestPayload): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing or invalid '${field}'`);
  }
  return value.trim();
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

async function writeAirtableBatch(args: {
  baseId: string;
  tableId: string;
  method: "POST" | "PATCH";
  records: AirtableWriteRecord[];
}): Promise<void> {
  const pat = Deno.env.get("AIRTABLE_PAT");
  if (!pat) throw new Error("AIRTABLE_PAT is not set");

  for (const batch of chunks(args.records, AIRTABLE_BATCH_SIZE)) {
    if (args.method === "PATCH" && batch.some((record) => !record.id)) {
      throw new Error("Airtable PATCH batch contains a record without an id");
    }
    const response = await fetchWithRetry(
      `https://api.airtable.com/v0/${args.baseId}/${args.tableId}`,
      {
        method: args.method,
        headers: {
          "Authorization": `Bearer ${pat}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: batch, typecast: true }),
      },
      {
        label: `Airtable ${args.method} C2C batch`,
        // PATCH is idempotent. A retried create after an ambiguous 5xx could
        // duplicate a row, so POST retries only requests rejected with 429.
        ...(args.method === "POST" ? { retryStatuses: [429] } : {}),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Airtable ${args.method} ${response.status}: ${body.slice(0, 800)}`);
    }
  }
}

async function listRequiredRecords(args: {
  baseId: string;
  tableId: string;
  fields: string[];
  label: string;
}): Promise<AirtableRecord[]> {
  const result = await listAirtableRecords({
    baseId: args.baseId,
    tableId: args.tableId,
    fields: args.fields,
  });
  if (!result.ok) throw new Error(`${args.label}: ${result.error ?? "Airtable list failed"}`);
  return result.records;
}

function uniqueRecordIndex(
  records: AirtableRecord[],
  matchField: string,
  label: string,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const record of records) {
    const display = airtableCellText(record.fields[matchField]);
    if (!display) continue;
    const key = normalizeRecordKey(display);
    if (index.has(key)) {
      throw new Error(`${label} contains duplicate '${display}' records`);
    }
    index.set(key, record.id);
  }
  return index;
}

function existingControlsByBaseline(records: AirtableRecord[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const record of records) {
    const ids = linkedRecordIds(record.fields[FIELDS.baselineControlId]);
    if (ids.length === 0) continue;
    if (ids.length > 1) {
      throw new Error(
        `Control record ${record.id} links more than one ${FIELDS.baselineControlId}`,
      );
    }
    if (index.has(ids[0])) {
      throw new Error(`Multiple control records link baseline record ${ids[0]}`);
    }
    index.set(ids[0], record.id);
  }
  return index;
}

async function resolveAndUpsertControls(args: {
  baseId: string;
  controls: ClientControl[];
  baselineTableId: string;
  baselineMatchField: string;
  tscTableId: string;
  tscMatchField: string;
  ownerFieldType?: string;
}): Promise<{ resolved: ResolvedControl[]; created: number; updated: number }> {
  const [baselineRecords, tscRecords, existingRecords] = await Promise.all([
    listRequiredRecords({
      baseId: args.baseId,
      tableId: args.baselineTableId,
      fields: [args.baselineMatchField],
      label: "Could not read the baseline-control link table",
    }),
    listRequiredRecords({
      baseId: args.baseId,
      tableId: args.tscTableId,
      fields: [args.tscMatchField],
      label: "Could not read the TSC link table",
    }),
    listRequiredRecords({
      baseId: args.baseId,
      tableId: AIRTABLE_CONTROLS_TABLE_ID,
      fields: [FIELDS.baselineControlId],
      label: "Could not read existing controls",
    }),
  ]);

  const baselines = uniqueRecordIndex(
    baselineRecords,
    args.baselineMatchField,
    "Baseline control table",
  );
  const criteria = uniqueRecordIndex(tscRecords, args.tscMatchField, "TSC table");
  const existing = existingControlsByBaseline(existingRecords);
  const unresolvedBaselines = new Set<string>();
  const unresolvedCriteria = new Set<string>();
  const resolved: ResolvedControl[] = [];

  for (const source of args.controls) {
    const baselineRecordId = baselines.get(normalizeRecordKey(source.control_id));
    if (!baselineRecordId) unresolvedBaselines.add(source.control_id);
    const tscRecordIds = source.criteria.flatMap((code) => {
      const recordId = criteria.get(normalizeRecordKey(code));
      if (!recordId) {
        unresolvedCriteria.add(code);
        return [];
      }
      return [recordId];
    });
    if (baselineRecordId) {
      resolved.push({
        source,
        baseline_record_id: baselineRecordId,
        tsc_record_ids: tscRecordIds,
        airtable_record_id: existing.get(baselineRecordId),
      });
    }
  }

  if (unresolvedBaselines.size > 0 || unresolvedCriteria.size > 0) {
    throw new Error(
      `Linked Airtable records could not be resolved` +
        `${
          unresolvedBaselines.size > 0
            ? `; Baseline Control ID: ${[...unresolvedBaselines].join(", ")}`
            : ""
        }` +
        `${
          unresolvedCriteria.size > 0 ? `; TSC Criteria: ${[...unresolvedCriteria].join(", ")}` : ""
        }`,
    );
  }

  const writes = resolved.map((control) => ({
    ...(control.airtable_record_id ? { id: control.airtable_record_id } : {}),
    fields: buildAirtableControlFields({
      control: control.source,
      baselineRecordId: control.baseline_record_id,
      tscRecordIds: control.tsc_record_ids,
      ownerFieldType: args.ownerFieldType,
      overviewRecordId: AIRTABLE_OVERVIEW_RECORD_ID,
    }),
  }));
  const updates = writes.filter((write) => Boolean(write.id));
  const creates = writes.filter((write) => !write.id);
  if (updates.length > 0) {
    await writeAirtableBatch({
      baseId: args.baseId,
      tableId: AIRTABLE_CONTROLS_TABLE_ID,
      method: "PATCH",
      records: updates,
    });
  }
  if (creates.length > 0) {
    await writeAirtableBatch({
      baseId: args.baseId,
      tableId: AIRTABLE_CONTROLS_TABLE_ID,
      method: "POST",
      records: creates,
    });
  }
  return { resolved, created: creates.length, updated: updates.length };
}

async function loadComparisonTargets(args: {
  baseId: string;
  controls: ResolvedControl[];
}): Promise<ComparisonTarget[]> {
  const expectedByBaseline = new Map(
    args.controls.map((control) => [control.baseline_record_id, control]),
  );
  let lastMissing: string[] = [];

  // Lookup/formula fields normally recalculate immediately. A small bounded
  // retry prevents a harmless Airtable recalculation delay from failing the run.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const records = await listRequiredRecords({
      baseId: args.baseId,
      tableId: AIRTABLE_CONTROLS_TABLE_ID,
      fields: [
        FIELDS.baselineControlId,
        FIELDS.controlDescription,
        FIELDS.baselineDescription,
      ],
      label: "Could not read descriptions for C2C comparison",
    });
    const recordsByBaseline = existingControlsByBaseline(records);
    const recordById = new Map(records.map((record) => [record.id, record]));
    const targets: ComparisonTarget[] = [];
    lastMissing = [];

    for (const [baselineRecordId, control] of expectedByBaseline) {
      const controlRecordId = recordsByBaseline.get(baselineRecordId);
      const record = controlRecordId ? recordById.get(controlRecordId) : undefined;
      const currentDescription = airtableCellText(record?.fields[FIELDS.controlDescription]);
      const baselineDescription = airtableCellText(record?.fields[FIELDS.baselineDescription]);
      if (!record || !currentDescription || !baselineDescription) {
        lastMissing.push(control.source.control_id);
        continue;
      }
      targets.push({
        airtable_record_id: record.id,
        input: {
          "Control ID": control.source.control_id,
          "Control Description": currentDescription,
          "Control Description (Baseline)": baselineDescription,
        },
      });
    }

    if (lastMissing.length === 0) return targets;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw new Error(
    `Control Description or Control Description (Baseline) is empty for: ${lastMissing.join(", ")}`,
  );
}

async function analyzeComparisons(targets: ComparisonTarget[]): Promise<{
  results: C2CResult[];
  prompt_id: string;
  prompt_version: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}> {
  const prompt = await loadActivePrompt(PROMPT_KEY);
  const results: C2CResult[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (const batch of chunks(targets, AI_BATCH_SIZE)) {
    const user = renderTemplate(prompt.user_prompt_template, {
      // Privacy/scope guard: the model receives only the three requested fields.
      controls_json: JSON.stringify(batch.map((target) => target.input), null, 2),
    });
    const claude = await callClaude({
      model: prompt.model,
      system: prompt.system_prompt,
      user,
      max_tokens: prompt.max_tokens,
      temperature: 0,
    });
    assertNotTruncated({
      stop_reason: claude.stop_reason,
      model: prompt.model,
      max_tokens: prompt.max_tokens,
      context: `prompt_key=${prompt.prompt_key}, batch_size=${batch.length}`,
    });
    const parsed = parseC2CResults(claude.text);
    validateC2CResultSet(parsed, batch.map((target) => target.input["Control ID"]));
    results.push(...parsed);
    inputTokens += claude.input_tokens;
    outputTokens += claude.output_tokens;
  }
  validateC2CResultSet(results, targets.map((target) => target.input["Control ID"]));
  return {
    results,
    prompt_id: prompt.prompt_id,
    prompt_version: prompt.version,
    model: prompt.model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

async function writeAnalysisResults(args: {
  baseId: string;
  targets: ComparisonTarget[];
  results: C2CResult[];
}): Promise<void> {
  const resultById = new Map(
    args.results.map((result) => [normalizeRecordKey(result.control_id), result]),
  );
  const writes = args.targets.map((target) => {
    const result = resultById.get(normalizeRecordKey(target.input["Control ID"]));
    if (!result) throw new Error(`No result for ${target.input["Control ID"]}`);
    return {
      id: target.airtable_record_id,
      fields: {
        [FIELDS.changeType]: result.change_type,
        [FIELDS.changeSuggestion]: result.baseline_change_suggestion,
      },
    };
  });
  await writeAirtableBatch({
    baseId: args.baseId,
    tableId: AIRTABLE_CONTROLS_TABLE_ID,
    method: "PATCH",
    records: writes,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authResult = await resolveEngagementByKey(req);
  if ("error" in authResult) return authResult.error;
  const { engagementId } = authResult;

  let payload: RequestPayload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  let baselineTableId: string;
  let baselineMatchField: string;
  let tscTableId: string;
  let tscMatchField: string;
  try {
    baselineTableId = requireString(payload, "baseline_table_id");
    baselineMatchField = requireString(payload, "baseline_match_field");
    tscTableId = requireString(payload, "tsc_table_id");
    tscMatchField = requireString(payload, "tsc_match_field");
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 400);
  }

  let engagement: EngagementContext;
  try {
    engagement = await withEngagementScope(engagementId, async (tx) => {
      const [row] = await tx<EngagementContext[]>`
        select google_drive_id, airtable_base, airtable_record_id
        from engagements
        where id = ${engagementId}
      `;
      if (!row) throw new Error(`Engagement ${engagementId} not found`);
      return row;
    });
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }

  let job;
  try {
    job = await startJobRun({
      function_name: FUNCTION_NAME,
      trigger_source: payload.trigger_source ?? "airtable",
      payload: {
        baseline_table_id: baselineTableId,
        baseline_match_field: baselineMatchField,
        tsc_table_id: tscTableId,
        tsc_match_field: tscMatchField,
      },
      engagement_id: engagementId,
    });
  } catch (err) {
    return jsonResponse({ error: `Failed to start job_run: ${(err as Error).message}` }, 500);
  }

  const setStatus = async (message: string): Promise<void> => {
    const result = await patchAirtableRecord({
      baseId: engagement.airtable_base,
      tableId: AIRTABLE_OVERVIEW_TABLE_ID,
      recordId: engagement.airtable_record_id,
      fields: { "💬": message },
    });
    if (result.attempted && !result.ok) {
      console.warn(`C2C overview status write failed: ${result.error}`);
    }
  };

  const runAnalysis = async (): Promise<AnalysisSummary> => {
    if (!engagement.google_drive_id) {
      throw new VisibleC2CError(
        "Missing Client Control CSV",
        `Engagement ${engagementId} has no google_drive_id`,
      );
    }
    if (!engagement.airtable_base || !engagement.airtable_record_id) {
      throw new Error("Engagement is missing its Airtable base or overview record ID");
    }

    const token = await getDriveAccessToken();
    const folders = await driveList(
      token,
      `'${engagement.google_drive_id}' in parents and ` +
        `mimeType = '${FOLDER_MIME}' and trashed = false`,
    );
    const matches = folders.filter((folder) => folder.name.trim() === CLIENT_CONTROL_FOLDER);
    if (matches.length === 0) {
      throw new VisibleC2CError(
        "Missing Client Control CSV",
        `No immediate '${CLIENT_CONTROL_FOLDER}' folder under ${engagement.google_drive_id}`,
      );
    }
    if (matches.length > 1) {
      throw new VisibleC2CError(
        "Multiple Client Control folders found",
        `Found ${matches.length} immediate '${CLIENT_CONTROL_FOLDER}' folders`,
      );
    }

    const folderFiles = await driveList(
      token,
      `'${matches[0].id}' in parents and trashed = false`,
    );
    const csvFiles = folderFiles.filter((file) =>
      file.mimeType !== FOLDER_MIME &&
      (file.name.toLowerCase().endsWith(".csv") || file.mimeType.includes("csv"))
    );
    if (csvFiles.length === 0) {
      throw new VisibleC2CError(
        "Missing Client Control CSV",
        `'${CLIENT_CONTROL_FOLDER}' contains no CSV file`,
      );
    }
    if (csvFiles.length > 1) {
      throw new VisibleC2CError(
        "Multiple Client Control CSVs found",
        `CSV files: ${csvFiles.map((file) => file.name).join(", ")}`,
      );
    }

    await setStatus("Uploading Client Controls");
    const csvBytes = await driveDownload(token, csvFiles[0].id);
    const parsed = parseClientControlCsv(new TextDecoder().decode(csvBytes));
    const upsert = await resolveAndUpsertControls({
      baseId: engagement.airtable_base,
      controls: parsed.controls,
      baselineTableId,
      baselineMatchField,
      tscTableId,
      tscMatchField,
      ownerFieldType: payload.owner_field_type,
    });

    await setStatus(`Analyzing ${parsed.controls.length} Client Controls`);
    const targets = await loadComparisonTargets({
      baseId: engagement.airtable_base,
      controls: upsert.resolved,
    });
    const analysis = await analyzeComparisons(targets);
    await writeAnalysisResults({
      baseId: engagement.airtable_base,
      targets,
      results: analysis.results,
    });

    const summary: AnalysisSummary = {
      csv_file: csvFiles[0].name,
      controls: parsed.controls.length,
      created: upsert.created,
      updated: upsert.updated,
      analyzed: analysis.results.length,
      prompt_id: analysis.prompt_id,
      prompt_version: analysis.prompt_version,
      model: analysis.model,
      input_tokens: analysis.input_tokens,
      output_tokens: analysis.output_tokens,
    };
    await setStatus(`✅ C2C Analysis complete — ${summary.analyzed} controls analyzed.`);
    await completeJobRun({
      handle: job,
      result: {
        ...summary,
        detected_columns: parsed.columns,
        ai_batches: Math.ceil(targets.length / AI_BATCH_SIZE),
      },
    });
    return summary;
  };

  const trackedAnalysis = async (): Promise<AnalysisSummary> => {
    try {
      return await runAnalysis();
    } catch (err) {
      const error = err as Error;
      const visible = err instanceof VisibleC2CError
        ? err.visibleMessage
        : `❌ C2C Analysis failed: ${error.message.slice(0, 300)}`;
      await setStatus(visible);
      await failJobRun({
        handle: job,
        error_message: error.message,
        error_stack: error.stack,
      });
      throw err;
    }
  };

  const edgeRuntime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(
      trackedAnalysis().catch((err) => console.error(`c2c-analysis crashed: ${err}`)),
    );
    return jsonResponse({
      accepted: true,
      status: "processing",
      engagement_id: engagementId,
      job_run_id: job.id,
    }, 202);
  }

  try {
    const summary = await trackedAnalysis();
    return jsonResponse({ success: true, ...summary, job_run_id: job.id });
  } catch (err) {
    return jsonResponse({ error: (err as Error).message, job_run_id: job.id }, 500);
  }
});
