// audit-pipeline.ts — the run-audit pipeline (preflight → Opus judgment →
// Sonnet workpaper → DB writes → Airtable write-back), extracted from
// run-audit/index.ts so BOTH entry points can run it (ADR-015):
//   - run-audit/index.ts    — HTTP entry (manual calls, smoke tests)
//   - audit-worker/index.ts — queue consumer (claims audit_queue rows)
//
// Why the worker imports this instead of POSTing to run-audit: per-engagement
// keys are stored only as SHA-256 hashes (engagements.api_key_hash), so a
// cron-woken worker has no plaintext key to authenticate with — the old chain
// only worked because sync forwarded its caller's inbound key. Importing the
// pipeline needs no key: scoping comes from withEngagementScope(engagementId),
// with the id taken from the queue row an authenticated caller wrote.
//
// Behavior is a faithful move of the old processAudit with two deliberate
// changes:
//   1. Returns a plain result object ({ok, status, body}) instead of a
//      Response, so callers decide how to surface it.
//   2. Airtable writes go through the shared retrying patchAirtableRecord
//      (429/5xx heal) instead of the old local no-retry fetch — the verdict
//      write was the least-protected write in the system.

import { withEngagementScope } from "./scoped-db.ts";
import type { Sql } from "./scoped-db.ts";
import { callClaude } from "./claude-client.ts";
import { loadActivePrompt } from "./load-prompt.ts";
import { renderTemplate } from "./render-template.ts";
import { completeJobRun, failJobRun, startJobRun } from "./job-run.ts";
import {
  assertNotTruncated,
  conformityLevelToDropdown,
  parseAuditResponse,
} from "./claude-parse.ts";
import { patchAirtableRecord } from "./airtable.ts";
import type { JobRunHandle } from "./types.ts";

// job_runs rows keep the run-audit name regardless of entry point, so existing
// monitoring queries / dashboards keep working unchanged.
const FUNCTION_NAME = "run-audit";
const PROMPT_KEY = "audit_judge";
const WORKPAPER_PROMPT_KEY = "workpaper_renderer";

// Opus 4.7 pricing per million tokens, USD.
const OPUS_INPUT_PER_M_USD = 5;
const OPUS_OUTPUT_PER_M_USD = 25;
// Sonnet 4.6 pricing per million tokens, USD.
const SONNET_INPUT_PER_M_USD = 3;
const SONNET_OUTPUT_PER_M_USD = 15;

const AIRTABLE_TABLE_ID = "tblZrxDzOKd9FJkbC";

export interface ControlRow {
  id: string;
  engagement_id: string;
  control_id: string;
  control_description: string | null;
  refined_expected_procedure: string | null;
  refinement_status: string;
  airtable_record_id: string | null;
}

interface AirtableSyncResult {
  attempted: boolean;
  ok: boolean;
  status?: number;
  error?: string;
  skip_reason?: "no_record_id" | "no_base_id" | "no_pat";
  omitted_fields?: string[];
  attachments_sent?: number;
}

interface WorkpaperRenderResult {
  attempted: boolean;
  ok: boolean;
  text?: string;
  prompt_id?: string;
  prompt_version?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  error?: string;
}

interface EvidenceRow {
  evidence_file_id: string;
  filename: string;
  file_type: string;
  storage_path: string;
  extracted_content: Record<string, unknown>;
}

// All client-data loaders accept a scoped tx — runs under engagement_scoped role
// with app.current_engagement_id stamped so the 0006 RLS policies bite.

async function loadControl(tx: Sql, controlId: string): Promise<ControlRow | null> {
  const rows = await tx<ControlRow[]>`
    select id, engagement_id, control_id, control_description,
           refined_expected_procedure, refinement_status, airtable_record_id
    from controls
    where id = ${controlId}
  `;
  return rows[0] ?? null;
}

async function loadEngagementMeta(
  tx: Sql,
  engagementId: string,
): Promise<{ attest_start: string; attest_end: string; airtable_base: string | null }> {
  // NOTE: `airtable_base` (migration 0009) holds the real base id (app...). The
  // separate `airtable_record_id` column (renamed in 0014 from the misnamed
  // airtable_base_id) holds the engagement row's Airtable RECORD id (rec...) —
  // it must NOT be used as the base id.
  const rows = await tx<
    { attest_start: string; attest_end: string; airtable_base: string | null }[]
  >`
    select attest_start, attest_end, airtable_base
    from engagements
    where id = ${engagementId}
  `;
  if (!rows[0]) throw new Error(`Engagement ${engagementId} not found`);
  return rows[0];
}

// Best-effort write-back to the control's Airtable row. Audit success does NOT
// depend on this — failures are logged in the run result but never fail the
// audit_run. Retries transient 429/5xx via the shared helper.
async function patchAirtable(args: {
  baseId: string | null;
  recordId: string | null;
  fields: Record<string, unknown>;
}): Promise<AirtableSyncResult> {
  return await patchAirtableRecord({
    baseId: args.baseId,
    tableId: AIRTABLE_TABLE_ID,
    recordId: args.recordId,
    fields: args.fields,
  });
}

async function loadTscString(tx: Sql, controlId: string): Promise<string> {
  const rows = await tx<{ tsc_code: string; description: string }[]>`
    select t.tsc_code, t.description
    from control_tscs ct
    join tscs t on t.id = ct.tsc_id
    where ct.control_id = ${controlId}
    order by t.tsc_code
  `;
  if (rows.length === 0) throw new Error(`Control has no linked TSCs`);
  return rows.map((t) => `${t.tsc_code}: ${t.description}`).join("\n");
}

async function loadLinkedEvidence(tx: Sql, controlId: string): Promise<EvidenceRow[]> {
  // Join evidence_control_links → evidence_files → extracted_evidence in one
  // scoped query. The join crosses three tables but all carry engagement_id and
  // the stamp filters them consistently via the 0006 policies.
  const rows = await tx<{
    evidence_file_id: string;
    filename: string;
    file_type: string;
    storage_path: string;
    extracted_content: Record<string, unknown>;
  }[]>`
    select
      ef.id          as evidence_file_id,
      ef.filename,
      ef.file_type,
      ef.storage_path,
      ee.extracted_content
    from evidence_control_links ecl
    join evidence_files ef on ef.id = ecl.evidence_file_id
    join extracted_evidence ee on ee.evidence_file_id = ef.id
    where ecl.control_id = ${controlId}
    order by ef.uploaded_at
  `;
  return rows;
}

function buildEvidenceSynthesis(rows: EvidenceRow[]): string {
  return rows
    .map(
      (r) =>
        `=== EVIDENCE: ${r.filename} (${r.file_type}) ===\n${
          JSON.stringify(r.extracted_content, null, 2)
        }\n`,
    )
    .join("\n");
}

// Preflight: scoped load of the control + the "ready to audit" checks. A
// control belonging to another engagement is invisible at the DB → "not found"
// rather than a data leak. Shared by the HTTP handler (which needs the control
// for its 202 ack) and the pipeline (when the caller didn't preload it).
export type AuditPreflight =
  | { ok: true; control: ControlRow }
  | { ok: false; status: number; error: string };

export async function loadControlForAudit(
  engagementId: string,
  controlUuid: string,
): Promise<AuditPreflight> {
  try {
    const c = await withEngagementScope(
      engagementId,
      (tx) => loadControl(tx, controlUuid),
    );
    if (!c) return { ok: false, status: 404, error: `Control ${controlUuid} not found` };
    // Defense-in-depth: RLS already guarantees this invariant.
    if (c.engagement_id !== engagementId) {
      return { ok: false, status: 403, error: "Unauthorized" };
    }
    if (c.refinement_status !== "refined") {
      return {
        ok: false,
        status: 400,
        error: `Control has refinement_status='${c.refinement_status}', expected 'refined'. ` +
          `Run refine-control first.`,
      };
    }
    if (!c.control_description || !c.refined_expected_procedure) {
      return {
        ok: false,
        status: 400,
        error: "Control is missing its original description or refined expected procedure",
      };
    }
    return { ok: true, control: c };
  } catch (err) {
    return { ok: false, status: 500, error: (err as Error).message };
  }
}

// The pipeline's outcome, shaped for either caller: the HTTP handler wraps
// body/status into a Response; the worker branches on ok/status to decide
// done / retry / dead-letter.
export interface AuditPipelineResult {
  ok: boolean;
  status: number; // HTTP-ish status (200 success, 4xx preflight, 500 failure)
  body: Record<string, unknown>;
}

export async function runAuditPipeline(args: {
  engagementId: string;
  controlUuid: string;
  triggerSource: string;
  control?: ControlRow; // pass when preflight already ran (HTTP handler)
  job?: JobRunHandle; // pass when the caller already opened the job_runs row
}): Promise<AuditPipelineResult> {
  const { engagementId, triggerSource } = args;

  // Resolve the control (worker path runs preflight here; handler passed it in).
  let control: ControlRow;
  if (args.control) {
    control = args.control;
  } else {
    const preflight = await loadControlForAudit(engagementId, args.controlUuid);
    if (!preflight.ok) {
      return { ok: false, status: preflight.status, body: { error: preflight.error } };
    }
    control = preflight.control;
  }

  // Parent job_run (unless the caller opened one for its ack).
  let job: JobRunHandle;
  if (args.job) {
    job = args.job;
  } else {
    try {
      job = await startJobRun({
        function_name: FUNCTION_NAME,
        trigger_source: triggerSource,
        payload: { control_uuid: control.id, trigger_source: triggerSource },
        engagement_id: control.engagement_id,
      });
    } catch (err) {
      return {
        ok: false,
        status: 500,
        body: { error: `Failed to start job_run: ${(err as Error).message}` },
      };
    }
  }

  // Tracked for failure path so we can mark audit_runs as failed.
  let auditRunId: string | null = null;
  const auditStart = Date.now();
  // Hoisted so the catch block can write a ❌ status back to Airtable (the
  // `engagement` row is scoped inside the try). Null until the engagement loads;
  // patchAirtable skips cleanly (no_base_id) if a failure happens before then.
  let airtableBase: string | null = null;

  try {
    // Load supporting data in parallel. Client-data loaders get their own short
    // scoped transactions; the prompt is a system table (service_role, via
    // loadActivePrompt's own client).
    const [engagement, tscsString, evidence, prompt] = await Promise.all([
      withEngagementScope(engagementId, (tx) => loadEngagementMeta(tx, control.engagement_id)),
      withEngagementScope(engagementId, (tx) => loadTscString(tx, control.id)),
      withEngagementScope(engagementId, (tx) => loadLinkedEvidence(tx, control.id)),
      loadActivePrompt(PROMPT_KEY),
    ]);

    // Live status: this pipeline OWNS the 💬 field for the whole audit phase —
    // including announcing its own start. Best-effort — never let a status
    // write fail the audit. Same base id (real app... column) used for the
    // final write-back.
    airtableBase = engagement.airtable_base;
    await patchAirtable({
      baseId: airtableBase,
      recordId: control.airtable_record_id,
      fields: { "ClearCheck 💬": "⏳ Launching audit… ClearCheck is thinking 🧠" },
    });

    if (evidence.length === 0) {
      throw new Error(
        `Control ${control.control_id} has no linked extracted evidence. Run ingest-evidence first.`,
      );
    }

    const evidenceSynthesis = buildEvidenceSynthesis(evidence);
    // ~4 chars/token. Early-warning gauge for the context ceiling: the synthesis
    // is uncapped (every extraction, verbatim), so this number in job_runs tells
    // us WHEN evidence-heavy controls approach the judge's budget — the trigger
    // for switching to summary/retrieval-tiered synthesis, per NEXT_STEPS.
    const synthesisEstTokens = Math.ceil(evidenceSynthesis.length / 4);
    const evidenceFileIds = [...new Set(evidence.map((e) => e.evidence_file_id))];

    const userText = renderTemplate(prompt.user_prompt_template, {
      control_description: control.control_description!,
      expected_procedures: control.refined_expected_procedure!,
      tscs: tscsString,
      evidence_synthesis: evidenceSynthesis,
      attest_start: engagement.attest_start,
      attest_end: engagement.attest_end,
    });

    // Insert audit_runs row before the Claude call so we have a target for
    // status='failed' if anything blows up downstream. Scoped write.
    auditRunId = await withEngagementScope(engagementId, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into audit_runs
          (engagement_id, control_id, evidence_file_ids, evidence_synthesis,
           audit_prompt_id, status, triggered_by)
        values
          (${control.engagement_id}, ${control.id}, ${evidenceFileIds},
           ${evidenceSynthesis}, ${prompt.prompt_id}, 'running',
           ${triggerSource})
        returning id
      `;
      if (!row) throw new Error("Failed to insert audit_runs: no row returned");
      return row.id;
    });

    // About to invoke Opus — the heavy step. Update 💬 so the user sees the
    // audit actually reasoning (distinct from the "launching" message above).
    await patchAirtable({
      baseId: airtableBase,
      recordId: control.airtable_record_id,
      fields: { "ClearCheck 💬": "🧠 ClearCheck is auditing the evidence" },
    });

    // Call Opus, then parse the XML-tagged verdict. The model occasionally omits
    // a required tag; since callClaude uses Anthropic's default temperature, a
    // re-roll differs and almost always includes all tags — so retry ONCE on a
    // parse failure before giving up. (Truncation is asserted first so it fails
    // with the clear "truncated" error, not a confusing parse error.)
    const MAX_AUDIT_ATTEMPTS = 2;
    let claude!: Awaited<ReturnType<typeof callClaude>>;
    let audit!: ReturnType<typeof parseAuditResponse>;
    for (let attempt = 1; attempt <= MAX_AUDIT_ATTEMPTS; attempt++) {
      claude = await callClaude({
        model: prompt.model,
        system: prompt.system_prompt,
        user: userText,
        max_tokens: prompt.max_tokens,
      });
      assertNotTruncated({
        stop_reason: claude.stop_reason,
        model: prompt.model,
        max_tokens: prompt.max_tokens,
        context: `prompt_key=${prompt.prompt_key}`,
      });
      try {
        audit = parseAuditResponse(claude.text);
        break;
      } catch (parseErr) {
        if (attempt === MAX_AUDIT_ATTEMPTS) throw parseErr;
        console.warn(
          `audit_judge parse failed (attempt ${attempt}/${MAX_AUDIT_ATTEMPTS}), ` +
            `retrying: ${(parseErr as Error).message.split("\n")[0]}`,
        );
      }
    }

    const cost = (claude.input_tokens * OPUS_INPUT_PER_M_USD +
      claude.output_tokens * OPUS_OUTPUT_PER_M_USD) / 1_000_000;

    // Scoped writes: insert audit_results and mark audit_runs + controls
    // completed in one transaction so they're atomic.
    const auditDurationMs = Date.now() - auditStart;
    const completedAt = new Date().toISOString();

    const resultData = await withEngagementScope(engagementId, async (tx) => {
      const [resultRow] = await tx<{ id: string }[]>`
        insert into audit_results
          (audit_run_id, conformity_status, conformity_determination, conformity_briefing,
           deviations, potential_clarifications, root_cause_category, root_cause_analysis,
           rendered_markdown, input_tokens, output_tokens, cost_usd)
        values
          (${auditRunId}, ${audit.conformity_status}, ${audit.conformity_determination},
           ${audit.conformity_briefing}, ${null}, ${audit.potential_clarifications ?? null},
           ${audit.root_cause_category ?? null}, ${audit.scratchpad ?? null},
           ${null}, ${claude.input_tokens}, ${claude.output_tokens}, ${cost})
        returning id
      `;
      if (!resultRow) throw new Error("Failed to insert audit_results: no row returned");

      await tx`
        update audit_runs
        set status = 'completed', completed_at = ${completedAt}, duration_ms = ${auditDurationMs}
        where id = ${auditRunId}
      `;
      await tx`
        update controls set latest_audit_run_id = ${auditRunId} where id = ${control.id}
      `;
      return resultRow;
    });

    // Workpaper Result-section render (Sonnet 4.6, deterministic temperature=0).
    // Best-effort — failure here NEVER fails the audit. Errors are captured in
    // workpaper_render below and surfaced via job_runs.result and the HTTP body.
    let workpaper: WorkpaperRenderResult = { attempted: false, ok: true };
    try {
      const wpPrompt = await loadActivePrompt(WORKPAPER_PROMPT_KEY);
      const wpUserText = renderTemplate(wpPrompt.user_prompt_template, {
        control_description: control.control_description!,
        expected_procedures: control.refined_expected_procedure!,
        conformity_determination: audit.conformity_determination,
        additional_comments: "",
      });

      const wpClaude = await callClaude({
        model: wpPrompt.model,
        system: wpPrompt.system_prompt,
        user: wpUserText,
        max_tokens: wpPrompt.max_tokens,
        temperature: 0,
      });

      // Drop everything from start through the closing </scratchpad>; keep only
      // the markdown that follows. If Claude emitted no scratchpad, keep full
      // text as-is. Case-insensitive on the tag.
      let body = wpClaude.text.replace(/^[\s\S]*?<\/scratchpad>\s*/i, "").trim();
      if (body.length === 0) body = wpClaude.text.trim();

      const wpCost = (wpClaude.input_tokens * SONNET_INPUT_PER_M_USD +
        wpClaude.output_tokens * SONNET_OUTPUT_PER_M_USD) / 1_000_000;

      workpaper = {
        attempted: true,
        ok: true,
        text: body,
        prompt_id: wpPrompt.prompt_id,
        prompt_version: wpPrompt.version,
        input_tokens: wpClaude.input_tokens,
        output_tokens: wpClaude.output_tokens,
        cost_usd: wpCost,
      };

      // Persist the rendered workpaper. Scoped write — best-effort.
      await withEngagementScope(
        engagementId,
        (tx) =>
          tx`update audit_results set rendered_markdown = ${body} where id = ${resultData.id}`,
      ).catch((e) => console.warn(`Failed to write rendered_markdown: ${e.message}`));
    } catch (err) {
      const msg = (err as Error).message;
      workpaper = { attempted: true, ok: false, error: msg };
      console.warn(`Workpaper render failed: ${msg}`);
    }

    // Best-effort write-back to Airtable. Errors here are logged in the run
    // result but do NOT fail the audit (the audit succeeded; only the display
    // mirror failed). 404 is treated like any other error: logged, audit OK.
    // All Airtable text fields are Single Line Text — coerce explicitly so a
    // number type doesn't trip 422 INVALID_VALUE_FOR_COLUMN.
    // NOTE: V3_Evidence (attachments) + V3_Evidence_Count are written earlier by
    // sync-control-evidence — it attaches the files to the control BEFORE the
    // Evidence Log is written, so run-audit no longer touches them here.
    // Merge the verdict INTO the ClearCheck 💬 field (V3_Status is no longer a
    // separate field). Display "No Deviation" instead of the internal
    // "Conforming" status; the other two statuses keep their names. The granular
    // level is still preserved separately in V3_Conformity_Level.
    const verdictDisplay = audit.conformity_status === "Conforming"
      ? "No Deviation"
      : String(audit.conformity_status);
    const airtableFields: Record<string, unknown> = {
      "ClearCheck 💬": `🥳 Audit complete — ${verdictDisplay}`,
      V3_Conformity_Level: conformityLevelToDropdown(String(audit.conformity_level)),
      V3_Determination: String(audit.conformity_determination),
      V3_Briefing: String(audit.conformity_briefing),
      V3_Root_cause_analysis: String(audit.scratchpad ?? ""),
      V3_Root_cause_category: String(audit.root_cause_category ?? ""),
      V3_Potential_clarifications: String(audit.potential_clarifications ?? ""),
      V3_Cost_USD: cost.toFixed(4),
      V3_Done_At: completedAt,
    };
    if (workpaper.ok && workpaper.text && workpaper.text.length > 0) {
      airtableFields.V3_Results = workpaper.text;
    }

    const airtableSyncRaw = await patchAirtable({
      baseId: engagement.airtable_base,
      recordId: control.airtable_record_id,
      fields: airtableFields,
    });
    const airtableSync: AirtableSyncResult = { ...airtableSyncRaw };
    if (airtableSync.attempted && !airtableSync.ok) {
      console.error(`Airtable write-back failed: ${airtableSync.error}`);
    }

    await completeJobRun({
      handle: job,
      result: {
        audit_run_id: auditRunId,
        audit_result_id: resultData.id,
        conformity_status: audit.conformity_status,
        conformity_level: audit.conformity_level,
        root_cause_category: audit.root_cause_category,
        evidence_count: evidence.length,
        evidence_file_count: evidenceFileIds.length,
        synthesis_est_tokens: synthesisEstTokens,
        prompt_id: prompt.prompt_id,
        prompt_version: prompt.version,
        model: prompt.model,
        input_tokens: claude.input_tokens,
        output_tokens: claude.output_tokens,
        cost_usd: cost,
        audit_duration_ms: auditDurationMs,
        airtable_sync: airtableSync,
        workpaper_render: workpaper,
      },
    });

    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        audit_run_id: auditRunId,
        audit_result_id: resultData.id,
        conformity_status: audit.conformity_status,
        conformity_level: audit.conformity_level,
        root_cause_category: audit.root_cause_category,
        determination_preview: audit.conformity_determination.slice(0, 240) +
          (audit.conformity_determination.length > 240 ? "…" : ""),
        tokens: { input: claude.input_tokens, output: claude.output_tokens },
        cost_usd: cost,
        audit_duration_ms: auditDurationMs,
        airtable_sync: airtableSync,
        workpaper_render: workpaper,
        job_run_id: job.id,
      },
    };
  } catch (err) {
    const e = err as Error;

    // Surface the failure on the record's 💬 field so it doesn't sit stuck on
    // "🧠 auditing…" forever. Best-effort; ignore its own errors.
    await patchAirtable({
      baseId: airtableBase,
      recordId: control.airtable_record_id,
      fields: { "ClearCheck 💬": `❌ Audit failed: ${e.message}` },
    }).catch(() => {});

    if (auditRunId) {
      const failedAt = new Date().toISOString();
      const failedDurationMs = Date.now() - auditStart;
      await withEngagementScope(engagementId, (tx) =>
        tx`
          update audit_runs
          set status = 'failed', completed_at = ${failedAt},
              duration_ms = ${failedDurationMs}, error_message = ${e.message}
          where id = ${auditRunId}
        `).catch((se) =>
          console.error(`Failed to mark audit_runs failed: ${(se as Error).message}`)
        );
    }

    await failJobRun({
      handle: job,
      error_message: e.message,
      error_stack: e.stack,
    });

    return {
      ok: false,
      status: 500,
      body: { error: e.message, job_run_id: job.id, audit_run_id: auditRunId },
    };
  }
}
