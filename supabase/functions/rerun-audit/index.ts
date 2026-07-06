// rerun-audit — REMEDIATION re-assessment of a single control AFTER the auditor
// submits NEW evidence and/or NEW notes ("Re-run Audit 🤖" field in Airtable).
//
// Unlike run-audit (the initial audit), this does NOT pull Google Drive and does
// NOT re-judge all evidence. It takes the PREVIOUS verdict + only the delta
// (newly-attached evidence + notes) and runs the audit_remediation prompt, which
// decides whether the new material overturns / closes / fails to close the prior
// gap. See ADR-013.
//
// Contract:
//   POST body: {
//     control_uuid: string,                 // controls.id (UUID) — required
//     mode?: "evidence" | "notes",          // intent hint (forgiving; see below)
//     additional_evidence?: { url, filename }[], // Airtable [Additional Evidence]
//     additional_notes?: string,            // Airtable [Additional Notes]
//     trigger_source?: string,
//   }
//   header: x-audit-secret (per-engagement key — identifies + authenticates)
//
// Forgiving behavior: regardless of `mode`, any attached evidence IS ingested and
// any notes ARE included — nothing the auditor staged is silently ignored. `mode`
// only colors the status wording.
//
// Async: acks 202 fast (Airtable's ~30s script cap), ingests + judges in a
// background task, and writes its own results + 💬 back to Airtable when done.
import { getServiceClient } from "../_shared/supabase-client.ts";
import { withEngagementScope } from "../_shared/scoped-db.ts";
import type { Sql } from "../_shared/scoped-db.ts";
import { callClaude } from "../_shared/claude-client.ts";
import { loadActivePrompt } from "../_shared/load-prompt.ts";
import { renderTemplate } from "../_shared/render-template.ts";
import { completeJobRun, failJobRun, startJobRun } from "../_shared/job-run.ts";
import { assertNotTruncated, parseAuditResponse } from "../_shared/claude-parse.ts";
import { resolveEngagementByKey } from "../_shared/auth.ts";
import { engagementSlug } from "../_shared/engagement-slug.ts";
import { ingestFile } from "../_shared/ingest-file.ts";
import type { IngestFileResult } from "../_shared/ingest-file.ts";
import { createAirtableRecord } from "../_shared/airtable.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@^2";

const FUNCTION_NAME = "rerun-audit";
const PROMPT_KEY = "audit_remediation";
const WORKPAPER_PROMPT_KEY = "workpaper_renderer";

// Opus 4.7 pricing per million tokens, USD (matches run-audit).
const OPUS_INPUT_PER_M_USD = 5;
const OPUS_OUTPUT_PER_M_USD = 25;
// Sonnet 4.6 pricing per million tokens, USD (workpaper).
const SONNET_INPUT_PER_M_USD = 3;
const SONNET_OUTPUT_PER_M_USD = 15;

const STORAGE_BUCKET = "evidence";
const SIGNED_URL_TTL_SECONDS = 86400; // 24h — Airtable caches the file within this window
const AIRTABLE_TABLE_ID = "tblZrxDzOKd9FJkbC"; // Ecton Controls
const AIRTABLE_EVIDENCE_LOG_TABLE_ID = "tblJz6xg6RbK8Q21M"; // Evidence Log

// How many additional-evidence files to ingest at once (mirrors
// sync-control-evidence; each file ≈ 30-45s on Haiku extract + OpenAI embed).
const EVIDENCE_CONCURRENCY = Math.max(1, Number(Deno.env.get("EVIDENCE_CONCURRENCY") ?? "5"));

interface Attachment {
  url: string;
  filename: string;
}

interface RequestPayload {
  control_uuid: string;
  mode?: "evidence" | "notes";
  additional_evidence?: Attachment[];
  additional_notes?: string;
  trigger_source?: string;
}

interface ControlRow {
  id: string;
  engagement_id: string;
  control_id: string;
  refined_control_description: string | null;
  refined_expected_procedure: string | null;
  refinement_status: string;
  airtable_record_id: string | null;
  latest_audit_run_id: string | null;
}

interface PreviousResult {
  conformity_level: string | null;
  conformity_determination: string | null;
  potential_clarifications: string | null;
}

interface EvidenceRow {
  evidence_file_id: string;
  filename: string;
  file_type: string;
  extracted_content: Record<string, unknown>;
}

interface AirtableSyncResult {
  attempted: boolean;
  ok: boolean;
  status?: number;
  error?: string;
  skip_reason?: "no_record_id" | "no_base_id" | "no_pat";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Run `worker` over `items` with at most `limit` in flight; preserves input order.
async function runConcurrent<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const pump = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await worker(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => pump()));
  return out;
}

async function loadControl(tx: Sql, controlId: string): Promise<ControlRow | null> {
  const rows = await tx<ControlRow[]>`
    select id, engagement_id, control_id, refined_control_description,
           refined_expected_procedure, refinement_status, airtable_record_id,
           latest_audit_run_id
    from controls
    where id = ${controlId}
  `;
  return rows[0] ?? null;
}

async function loadEngagementMeta(
  tx: Sql,
  engagementId: string,
): Promise<{ attest_start: string; attest_end: string; airtable_base: string | null }> {
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

// The verdict this re-run supersedes — read from the control's latest audit_run.
async function loadPreviousResult(
  tx: Sql,
  auditRunId: string,
): Promise<PreviousResult | null> {
  // audit_results.conformity_level was dropped in migration 0004 — the only
  // persisted verdict label is conformity_status. Alias it back to
  // conformity_level so the remediation prompt's {{previous_conformity_level}}
  // placeholder still receives a meaningful value.
  const rows = await tx<PreviousResult[]>`
    select conformity_status as conformity_level,
           conformity_determination,
           potential_clarifications
    from audit_results
    where audit_run_id = ${auditRunId}
    order by generated_at desc
    limit 1
  `;
  return rows[0] ?? null;
}

// Extracted content for a specific set of newly-ingested files (the delta).
async function loadExtractedByFileIds(tx: Sql, fileIds: string[]): Promise<EvidenceRow[]> {
  if (fileIds.length === 0) return [];
  const rows = await tx<EvidenceRow[]>`
    select ef.id as evidence_file_id, ef.filename, ef.file_type, ee.extracted_content
    from evidence_files ef
    join extracted_evidence ee on ee.evidence_file_id = ef.id
    where ef.id = any(${fileIds}::uuid[])
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

// ALL of the control's currently-linked evidence files (initial + the additional
// ones just ingested). One row per file. Used to rebuild the V3_Evidence
// attachment mirror so it reflects the complete evidence set after a re-run.
async function loadLinkedFiles(
  tx: Sql,
  controlId: string,
): Promise<{ storage_path: string; filename: string }[]> {
  return await tx<{ storage_path: string; filename: string }[]>`
    select ef.storage_path, ef.filename
    from evidence_control_links ecl
    join evidence_files ef on ef.id = ecl.evidence_file_id
    where ecl.control_id = ${controlId}
    order by ef.filename
  `;
}

// Best-effort signed-URL generation (mirrors run-audit). Per-file failures are
// logged and skipped; never fails the re-run.
async function generateSignedUrls(
  supabase: SupabaseClient,
  files: { storage_path: string; filename: string }[],
): Promise<{ url: string; filename: string }[]> {
  const out: { url: string; filename: string }[] = [];
  for (const file of files) {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(file.storage_path, SIGNED_URL_TTL_SECONDS);
    if (error || !data) {
      console.warn(`Failed to sign URL for ${file.filename}: ${error?.message ?? "no data"}`);
      continue;
    }
    out.push({ url: data.signedUrl, filename: file.filename });
  }
  return out;
}

// Maps internal FileType → the Airtable Evidence Log "File Type" singleSelect
// options (same mapping as sync-control-evidence).
function airtableFileType(fileType: string | undefined): string | undefined {
  if (!fileType) return undefined;
  if (fileType === "pdf_small" || fileType === "pdf_large") return "PDF";
  if (fileType === "csv") return "CSV";
  if (fileType === "image") return "PNG";
  if (fileType === "doc") return "Docx";
  return undefined;
}

// Best-effort Evidence Log row creator — one row per additional file processed.
// Mirrors sync-control-evidence's row, but ticks "Additional Evidence" so re-run
// files are distinguishable from the initial run's. Never throws.
async function createEvidenceLogRow(args: {
  baseId: string | null;
  controlRecordId: string | null;
  result: IngestFileResult;
}): Promise<void> {
  if (!args.baseId || !args.controlRecordId) return;

  const fields: Record<string, unknown> = {
    Filename: args.result.filename,
    "Processing Status": args.result.status === "failed" ? "Error" : "Complete",
    // Link to the control record. Airtable REST wants an array of record-ID STRINGS
    // (["rec…"]), NOT [{id:"rec…"}] — the object form fails with INVALID_RECORD_ID.
    Controls: [args.controlRecordId],
    // Flag: this row came from a re-run (additional) submission, not the
    // initial Drive sync.
    "Additional Evidence": true,
  };

  const ft = airtableFileType(args.result.file_type);
  if (ft) fields["File Type"] = ft;
  if (args.result.file_size_bytes != null) {
    fields["File_Size (MB)"] = (args.result.file_size_bytes / 1048576).toFixed(3);
  }
  if (args.result.extracted_summary) fields["Extracted_Data"] = args.result.extracted_summary;
  if (args.result.scratchpad) fields["Scratchpad"] = args.result.scratchpad;
  const note = args.result.error ?? args.result.skip_reason ?? "";
  if (note) fields["Evidence_Note"] = note;
  if (args.result.tokens) {
    fields["Input Tokens"] = args.result.tokens.input;
    fields["Output Tokens"] = args.result.tokens.output;
  }

  const res = await createAirtableRecord({
    baseId: args.baseId,
    tableId: AIRTABLE_EVIDENCE_LOG_TABLE_ID,
    fields,
  }).catch((e: Error) => ({ attempted: true, ok: false, error: e.message }));
  if (!res.ok) {
    console.warn(`Evidence Log write failed for ${args.result.filename}: ${res.error}`);
  }
}

// Best-effort write-back to Airtable. A re-run's success never depends on it.
async function patchAirtable(args: {
  baseId: string | null;
  recordId: string | null;
  fields: Record<string, unknown>;
}): Promise<AirtableSyncResult> {
  if (!args.recordId) return { attempted: false, ok: true, skip_reason: "no_record_id" };
  if (!args.baseId) return { attempted: false, ok: true, skip_reason: "no_base_id" };

  const pat = Deno.env.get("AIRTABLE_PAT");
  if (!pat) return { attempted: false, ok: true, skip_reason: "no_pat" };

  const url = `https://api.airtable.com/v0/${args.baseId}/${AIRTABLE_TABLE_ID}/${args.recordId}`;
  try {
    const resp = await fetch(url, {
      method: "PATCH",
      headers: { "Authorization": `Bearer ${pat}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: args.fields }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      return {
        attempted: true,
        ok: false,
        status: resp.status,
        error: `Airtable PATCH ${resp.status}: ${body.slice(0, 500)}`,
      };
    }
    return { attempted: true, ok: true, status: resp.status };
  } catch (err) {
    return { attempted: true, ok: false, error: `Airtable fetch threw: ${(err as Error).message}` };
  }
}

async function setStatus(
  baseId: string | null,
  recordId: string | null,
  msg: string,
): Promise<void> {
  await patchAirtable({ baseId, recordId, fields: { "ClearCheck 💬": msg } }).catch(() => {});
}

// Renders a 10-segment emoji progress bar string for the ClearCheck 💬 field
// (Option B — server-rendered into the text field, not an Airtable formula).
// 🟩 renders green in Airtable; plain block chars can't be colored.
const PROGRESS_SEGMENTS = 10;
function progressBar(done: number, total: number): string {
  const filled = total > 0
    ? Math.min(PROGRESS_SEGMENTS, Math.round((done / total) * PROGRESS_SEGMENTS))
    : 0;
  return "🟩".repeat(filled) + "⬜".repeat(PROGRESS_SEGMENTS - filled) + `  ${done}/${total}`;
}

Deno.serve(async (req: Request) => {
  // Per-engagement key auth — resolves which engagement this caller owns.
  const authResult = await resolveEngagementByKey(req);
  if ("error" in authResult) return authResult.error;
  const { engagementId } = authResult;

  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let payload: RequestPayload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (typeof payload.control_uuid !== "string" || !payload.control_uuid) {
    return jsonResponse({ error: "Missing or invalid 'control_uuid'" }, 400);
  }

  const attachments: Attachment[] = Array.isArray(payload.additional_evidence)
    ? payload.additional_evidence.filter(
      (a): a is Attachment =>
        !!a && typeof a.url === "string" && typeof a.filename === "string",
    )
    : [];
  const notes = typeof payload.additional_notes === "string" ? payload.additional_notes.trim() : "";

  // Nothing staged → nothing to remediate. Fail loud so the auditor knows.
  if (attachments.length === 0 && notes === "") {
    return jsonResponse(
      { error: "No additional evidence or notes provided — nothing to re-assess." },
      400,
    );
  }

  const mode = payload.mode === "notes" ? "notes" : payload.mode === "evidence" ? "evidence" : "rerun";
  const triggerSource = payload.trigger_source ?? "airtable";

  // Pre-flight: scoped load of the control + its previous verdict.
  let control: ControlRow;
  let previous: PreviousResult;
  let engagement: { attest_start: string; attest_end: string; airtable_base: string | null };
  try {
    const loaded = await withEngagementScope(engagementId, async (tx) => {
      const c = await loadControl(tx, payload.control_uuid);
      const prev = c && c.latest_audit_run_id
        ? await loadPreviousResult(tx, c.latest_audit_run_id)
        : null;
      const eng = c ? await loadEngagementMeta(tx, c.engagement_id) : null;
      return { c, prev, eng };
    });

    if (!loaded.c) return jsonResponse({ error: `Control ${payload.control_uuid} not found` }, 404);
    // Defense-in-depth: RLS already guarantees this.
    if (loaded.c.engagement_id !== engagementId) {
      return jsonResponse({ error: "Unauthorized" }, 403);
    }
    if (!loaded.c.latest_audit_run_id || !loaded.prev) {
      return jsonResponse(
        { error: "No previous audit to re-assess. Run an initial audit first." },
        400,
      );
    }
    if (
      loaded.c.refinement_status !== "refined" ||
      !loaded.c.refined_control_description ||
      !loaded.c.refined_expected_procedure
    ) {
      return jsonResponse(
        { error: "Control is not refined — run the initial audit chain first." },
        400,
      );
    }
    control = loaded.c;
    previous = loaded.prev;
    engagement = loaded.eng!;
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }

  let job;
  try {
    job = await startJobRun({
      function_name: FUNCTION_NAME,
      trigger_source: triggerSource,
      payload: {
        control_uuid: control.id,
        control_id: control.control_id,
        mode,
        attachment_count: attachments.length,
        has_notes: notes.length > 0,
      },
      engagement_id: control.engagement_id,
    });
  } catch (err) {
    return jsonResponse({ error: `Failed to start job_run: ${(err as Error).message}` }, 500);
  }

  const airtableBase = engagement.airtable_base;
  const previousAuditRunId = control.latest_audit_run_id!;

  const processRerun = async (): Promise<Response> => {
    let auditRunId: string | null = null;
    const runStart = Date.now();
    try {
      await setStatus(
        airtableBase,
        control.airtable_record_id,
        attachments.length > 0
          ? "🔄 Re-running ClearCheck with new evidence…"
          : "🔄 Re-running ClearCheck with new notes…",
      );

      // 1. Ingest the newly-attached evidence (download from Airtable → Storage →
      //    ingestFile). Dedup by hash means a re-submitted file is cheap.
      const slug = engagementSlug(control.engagement_id);
      const supabase = getServiceClient();
      const newFileIds = new Set<string>();

      const totalFiles = attachments.length;
      let doneFiles = 0;
      let lastBarShown = -1; // monotonic guard against out-of-order status PATCHes
      if (totalFiles > 0) {
        // Switch 💬 to a progress bar while the additional files ingest (Option B).
        await setStatus(airtableBase, control.airtable_record_id, progressBar(0, totalFiles));
        const ingestOne = async (att: Attachment): Promise<void> => {
          const storagePath = `${slug}/${control.control_id}/${att.filename}`;
          let bytes: Uint8Array;
          try {
            const resp = await fetch(att.url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            bytes = new Uint8Array(await resp.arrayBuffer());
          } catch (err) {
            console.warn(`Attachment download failed (${att.filename}): ${(err as Error).message}`);
            return;
          }
          const { error: upErr } = await supabase.storage
            .from(STORAGE_BUCKET)
            .upload(storagePath, bytes, { upsert: true });
          if (upErr) {
            console.warn(`Storage upload failed (${att.filename}): ${upErr.message}`);
            return;
          }
          const r = await ingestFile({
            engagement_id: control.engagement_id,
            control_id: control.id,
            file_path: storagePath,
            filename: att.filename,
            file_bytes: bytes,
            trigger_source: triggerSource,
          });
          // Mirror to the Airtable Evidence Log (best-effort), ticking
          // "Additional Evidence" so it's distinguishable from initial evidence.
          await createEvidenceLogRow({
            baseId: airtableBase,
            controlRecordId: control.airtable_record_id,
            result: r,
          });
          // Both freshly-extracted and dedup-skipped files carry a usable id.
          const id = r.evidence_file_id ?? r.existing_file_id ?? null;
          if (id && r.status !== "failed") newFileIds.add(id);
        };
        await runConcurrent(attachments, EVIDENCE_CONCURRENCY, async (att) => {
          await ingestOne(att);
          const done = ++doneFiles;
          if (done > lastBarShown) {
            lastBarShown = done;
            await setStatus(airtableBase, control.airtable_record_id, progressBar(done, totalFiles));
          }
        });
      }

      // 2. Build the NEW Evidence Analysis from just the delta files.
      const newFileIdList = [...newFileIds];
      const newEvidence = await withEngagementScope(
        engagementId,
        (tx) => loadExtractedByFileIds(tx, newFileIdList),
      );
      const additionalEvidenceAnalysis = newEvidence.length > 0
        ? buildEvidenceSynthesis(newEvidence)
        : "(No new evidence files were submitted with this re-run.)";

      // 3. Render the remediation prompt with the previous verdict + delta.
      const prompt = await loadActivePrompt(PROMPT_KEY);
      const userText = renderTemplate(prompt.user_prompt_template, {
        control_description: control.refined_control_description!,
        expected_procedures: control.refined_expected_procedure!,
        attest_start: engagement.attest_start,
        attest_end: engagement.attest_end,
        previous_conformity_level: previous.conformity_level ?? "(unknown)",
        previous_determination: previous.conformity_determination ?? "(none recorded)",
        previous_clarifications: previous.potential_clarifications ?? "(none)",
        additional_evidence_analysis: additionalEvidenceAnalysis,
        additional_notes: notes.length > 0 ? notes : "(none)",
      });

      // 4. Record the remediation audit_run before the Claude call.
      auditRunId = await withEngagementScope(engagementId, async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          insert into audit_runs
            (engagement_id, control_id, evidence_file_ids, evidence_synthesis,
             audit_prompt_id, status, triggered_by, run_type, auditor_notes,
             previous_audit_run_id)
          values
            (${control.engagement_id}, ${control.id}, ${newFileIdList}::uuid[],
             ${additionalEvidenceAnalysis}, ${prompt.prompt_id}, 'running',
             ${triggerSource}, 'remediation', ${notes.length > 0 ? notes : null},
             ${previousAuditRunId})
          returning id
        `;
        if (!row) throw new Error("Failed to insert audit_runs: no row returned");
        return row.id;
      });

      await setStatus(
        airtableBase,
        control.airtable_record_id,
        "🧠 ClearCheck is re-assessing the evidence",
      );

      // 5. Call Opus (remediation judge).
      const claude = await callClaude({
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

      const audit = parseAuditResponse(claude.text);
      const cost = (claude.input_tokens * OPUS_INPUT_PER_M_USD +
        claude.output_tokens * OPUS_OUTPUT_PER_M_USD) / 1_000_000;

      const durationMs = Date.now() - runStart;
      const completedAt = new Date().toISOString();

      const resultData = await withEngagementScope(engagementId, async (tx) => {
        // NOTE: audit_results.conformity_level was dropped in migration 0004 —
        // the level lives only on Airtable's V3_Conformity_Level now. Column set
        // here matches run-audit exactly.
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
          set status = 'completed', completed_at = ${completedAt}, duration_ms = ${durationMs}
          where id = ${auditRunId}
        `;
        await tx`update controls set latest_audit_run_id = ${auditRunId} where id = ${control.id}`;
        return resultRow;
      });

      // 6. Workpaper Result render (Sonnet, temperature 0) — best-effort. Auditor
      //    notes flow into the prompt's existing ENGAGEMENT CONTEXT slot.
      let workpaperText: string | null = null;
      try {
        const wpPrompt = await loadActivePrompt(WORKPAPER_PROMPT_KEY);
        const wpUserText = renderTemplate(wpPrompt.user_prompt_template, {
          control_description: control.refined_control_description!,
          expected_procedures: control.refined_expected_procedure!,
          conformity_determination: audit.conformity_determination,
          additional_comments: notes,
        });
        const wpClaude = await callClaude({
          model: wpPrompt.model,
          system: wpPrompt.system_prompt,
          user: wpUserText,
          max_tokens: wpPrompt.max_tokens,
          temperature: 0,
        });
        let body = wpClaude.text.replace(/^[\s\S]*?<\/scratchpad>\s*/i, "").trim();
        if (body.length === 0) body = wpClaude.text.trim();
        workpaperText = body;
        await withEngagementScope(engagementId, (tx) =>
          tx`update audit_results set rendered_markdown = ${body} where id = ${resultData.id}`
        ).catch((e) => console.warn(`Failed to write rendered_markdown: ${e.message}`));
      } catch (err) {
        console.warn(`Workpaper render failed: ${(err as Error).message}`);
      }

      // 7. Evidence write-back. Rebuild V3_Evidence from the control's FULL
      //    linked evidence set (initial + the additional files just ingested) —
      //    rebuilding from the DB (the source of truth) makes the attachment
      //    mirror complete without a read-merge against Airtable. Omit the field
      //    when empty so we never CLEAR a prior run's attachments with [].
      let signedUrls: { url: string; filename: string }[] = [];
      try {
        const linked = await withEngagementScope(
          engagementId,
          (tx) => loadLinkedFiles(tx, control.id),
        );
        signedUrls = await generateSignedUrls(supabase, linked);
      } catch (err) {
        console.warn(`Evidence write-back prep failed: ${(err as Error).message}`);
      }

      // 8. Write the new verdict back to Airtable.
      const verdictDisplay = audit.conformity_status === "Conforming"
        ? "No Deviation"
        : String(audit.conformity_status);
      const airtableFields: Record<string, unknown> = {
        "ClearCheck 💬": `🥳 Re-run complete — ${verdictDisplay}`,
        V3_Conformity_Level: String(audit.conformity_level),
        V3_Determination: String(audit.conformity_determination),
        V3_Briefing: String(audit.conformity_briefing),
        V3_Root_cause_analysis: String(audit.scratchpad ?? ""),
        V3_Root_cause_category: String(audit.root_cause_category ?? ""),
        V3_Potential_clarifications: String(audit.potential_clarifications ?? ""),
        V3_Cost_USD: cost.toFixed(4),
        V3_Run_At: completedAt,
      };
      if (signedUrls.length > 0) {
        airtableFields.V3_Evidence = signedUrls;
        airtableFields.V3_Evidence_Count = signedUrls.length;
      }
      if (workpaperText && workpaperText.length > 0) airtableFields.V3_Results = workpaperText;

      const airtableSync = await patchAirtable({
        baseId: airtableBase,
        recordId: control.airtable_record_id,
        fields: airtableFields,
      });
      if (airtableSync.attempted && !airtableSync.ok) {
        console.error(`Airtable write-back failed: ${airtableSync.error}`);
      }

      await completeJobRun({
        handle: job,
        result: {
          audit_run_id: auditRunId,
          audit_result_id: resultData.id,
          run_type: "remediation",
          previous_audit_run_id: previousAuditRunId,
          mode,
          conformity_status: audit.conformity_status,
          conformity_level: audit.conformity_level,
          root_cause_category: audit.root_cause_category,
          new_evidence_files: newFileIdList.length,
          evidence_attachments_written: signedUrls.length,
          had_notes: notes.length > 0,
          input_tokens: claude.input_tokens,
          output_tokens: claude.output_tokens,
          cost_usd: cost,
          duration_ms: durationMs,
          airtable_sync: airtableSync,
        },
      });

      return jsonResponse({
        success: true,
        audit_run_id: auditRunId,
        audit_result_id: resultData.id,
        run_type: "remediation",
        conformity_status: audit.conformity_status,
        conformity_level: audit.conformity_level,
        cost_usd: cost,
        new_evidence_files: newFileIdList.length,
        airtable_sync: airtableSync,
        job_run_id: job.id,
      });
    } catch (err) {
      const e = err as Error;
      await setStatus(
        airtableBase,
        control.airtable_record_id,
        `❌ Re-run failed: ${e.message}`,
      );
      if (auditRunId) {
        await withEngagementScope(engagementId, (tx) =>
          tx`
            update audit_runs
            set status = 'failed', completed_at = ${new Date().toISOString()},
                duration_ms = ${Date.now() - runStart}, error_message = ${e.message}
            where id = ${auditRunId}
          `
        ).catch((se) => console.error(`Failed to mark audit_runs failed: ${(se as Error).message}`));
      }
      await failJobRun({ handle: job, error_message: e.message, error_stack: e.stack });
      return jsonResponse({ error: e.message, job_run_id: job.id, audit_run_id: auditRunId }, 500);
    }
  };

  // Dispatch: background in prod (ack 202 under Airtable's 30s cap), inline
  // locally (preserve the synchronous contract for tests/hand calls).
  const edgeRuntime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(
      processRerun().catch((e) => console.error(`processRerun crashed: ${e}`)),
    );
    return jsonResponse(
      {
        accepted: true,
        status: "processing",
        control_uuid: control.id,
        engagement_id: control.engagement_id,
        mode,
        job_run_id: job.id,
        note: "Re-run runs in the background; results are written to Airtable when complete.",
      },
      202,
    );
  }
  return await processRerun();
});
