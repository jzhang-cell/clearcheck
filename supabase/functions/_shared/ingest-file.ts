import { completeJobRun, failJobRun, startJobRun } from "./job-run.ts";
import { withEngagementScope } from "./scoped-db.ts";
import type { Sql } from "./scoped-db.ts";
import { detectFileType, mimeTypeFor, primaryPromptKeyFor } from "./file-type.ts";
import type { FileType } from "./file-type.ts";
import { extractByType } from "./extract-by-type.ts";
import { xlsxToCsv } from "./xlsx-to-csv.ts";
import { loadActivePrompt } from "./load-prompt.ts";
import { generateEmbedding } from "./openai-client.ts";
import { dispatchMakeExtraction, shouldUseMakeExtraction } from "./external-extraction.ts";

const FUNCTION_NAME = "ingest-evidence";

export interface IngestFileArgs {
  engagement_id: string;
  control_id: string; // controls.id (UUID)
  file_path: string; // storage path used for storage_path column
  filename: string;
  file_bytes: Uint8Array;
  // Original Drive object. Make uses this ID with its own Google Drive
  // connection.
  google_drive_file_id?: string;
  // Airtable evidence has no Drive ID. sync-control-evidence supplies a
  // time-limited URL for the already-uploaded Storage object so Make can fetch
  // a large PDF without receiving a Supabase service credential.
  external_download_url?: string;
  trigger_source?: string; // 'manual' | 'batch' | webhook source — caller decides
  // Present when sync-control-evidence owns the orchestration. It lets a large
  // PDF return "queued" and resume the same sync after Make calls back.
  sync_run_id?: string;
}

export interface IngestFileResult {
  status: "extracted" | "skipped" | "queued" | "failed";
  filename: string;
  evidence_file_id: string | null;
  extracted_evidence_id?: string;
  skip_reason?: "file_dedupe" | "extraction_dedupe";
  existing_file_id?: string;
  existing_extraction_id?: string;
  external_job_id?: string;
  job_run_id: string | null; // null only if startJobRun itself failed
  duration_ms: number;
  tokens?: { input: number; output: number; embedding: number };
  error?: string;
  // Evidence Log write-back fields — populated on extracted/skipped, absent on hard failure
  file_type?: string; // FileType value, e.g. "pdf_small", "csv", "image", "doc"
  file_size_bytes?: number;
  storage_path?: string;
  extracted_summary?: string; // document_summary from extracted_content, or truncated JSON
  scratchpad?: string | null;
}

interface ControlRow {
  id: string;
  engagement_id: string;
  control_id: string;
  control_description: string | null;
  expected_procedures: string | null;
  refined_expected_procedure: string | null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // TS 5.7's lib.dom narrows BufferSource to ArrayBufferView<ArrayBuffer>,
  // which Uint8Array<ArrayBufferLike> doesn't satisfy. Runtime accepts it.
  // deno-lint-ignore no-explicit-any
  const buf = await crypto.subtle.digest("SHA-256", bytes as any);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// All helpers below accept a scoped tx so they run under the engagement_scoped
// role with app.current_engagement_id stamped. RLS filters every query to the
// owning engagement at the DB — isolation isn't just in code.

async function loadControl(tx: Sql, controlId: string): Promise<ControlRow | null> {
  const rows = await tx<ControlRow[]>`
    select id, engagement_id, control_id, control_description, expected_procedures,
           refined_expected_procedure
    from controls
    where id = ${controlId}
  `;
  return rows[0] ?? null;
}

async function loadTscString(tx: Sql, controlId: string): Promise<string> {
  const rows = await tx<{ tsc_code: string; description: string }[]>`
    select t.tsc_code, t.description
    from control_tscs ct
    join tscs t on t.id = ct.tsc_id
    where ct.control_id = ${controlId}
    order by t.tsc_code
  `;
  if (rows.length === 0) throw new Error(`Control ${controlId} has no linked TSCs`);
  return rows.map((t) => `${t.tsc_code}: ${t.description}`).join("\n");
}

async function findExistingFile(
  tx: Sql,
  engagementId: string,
  fileHash: string,
): Promise<{ id: string } | null> {
  const rows = await tx<{ id: string }[]>`
    select id from evidence_files
    where engagement_id = ${engagementId} and file_hash = ${fileHash}
    limit 1
  `;
  return rows[0] ?? null;
}

async function findExistingExtraction(
  tx: Sql,
  evidenceFileId: string,
  extractorPromptId: string,
): Promise<{ id: string } | null> {
  const rows = await tx<{ id: string }[]>`
    select id from extracted_evidence
    where evidence_file_id = ${evidenceFileId}
      and extractor_prompt_id = ${extractorPromptId}
      and extracted_content is not null
    limit 1
  `;
  return rows[0] ?? null;
}

async function linkFileToControl(
  tx: Sql,
  evidenceFileId: string,
  controlId: string,
): Promise<void> {
  // The trg_evidence_control_links_engagement trigger auto-derives engagement_id
  // from the controls parent, so we omit it here.
  await tx`
    insert into evidence_control_links (evidence_file_id, control_id)
    values (${evidenceFileId}, ${controlId})
    on conflict (evidence_file_id, control_id) do nothing
  `;
}

async function insertOrGetEvidenceFile(
  tx: Sql,
  args: {
    engagement_id: string;
    file_hash: string;
    filename: string;
    file_type: FileType;
    file_size_bytes: number;
    mime_type: string;
    storage_path: string;
  },
): Promise<{ id: string; inserted: boolean }> {
  const [row] = await tx<{ id: string }[]>`
    insert into evidence_files
      (engagement_id, file_hash, filename, file_type, file_size_bytes, mime_type,
       storage_path, status)
    values
      (${args.engagement_id}, ${args.file_hash}, ${args.filename}, ${args.file_type},
       ${args.file_size_bytes}, ${args.mime_type}, ${args.storage_path}, 'processing')
    on conflict (engagement_id, file_hash) do nothing
    returning id
  `;
  if (row) return { id: row.id, inserted: true };

  // Another worker inserted the same content between our initial dedupe read
  // and this write. The unique index is the source of truth: reuse that row
  // instead of surfacing a duplicate-key failure to the auditor.
  const existing = await findExistingFile(tx, args.engagement_id, args.file_hash);
  if (!existing) {
    throw new Error("Evidence dedupe conflict occurred but the existing row could not be loaded");
  }
  return { id: existing.id, inserted: false };
}

async function updateEvidenceFileStatus(
  tx: Sql,
  id: string,
  status: "extracted" | "failed",
  errorMessage: string | null,
): Promise<void> {
  await tx`
    update evidence_files
    set status = ${status}, error_message = ${errorMessage}
    where id = ${id}
  `;
}

async function markEvidenceFileFailedUnlessExtracted(
  tx: Sql,
  id: string,
  errorMessage: string,
): Promise<void> {
  // A concurrent worker can finish the shared file after this worker fails.
  // Never overwrite that successful terminal state with a late failure.
  await tx`
    update evidence_files ef
    set status = 'failed', error_message = ${errorMessage}
    where ef.id = ${id}
      and not exists (
        select 1 from extracted_evidence ee where ee.evidence_file_id = ef.id
      )
  `;
}

function pickEmbeddingSource(
  filename: string,
  extractedContent: Record<string, unknown>,
): string {
  const docSummary = extractedContent.document_summary;
  if (typeof docSummary === "string" && docSummary.length > 0) return docSummary;
  const summary = extractedContent.summary;
  if (typeof summary === "string" && summary.length > 0) return summary;
  const json = JSON.stringify(extractedContent);
  return `${filename}\n\n${json.slice(0, 1000)}`;
}

export async function ingestFile(args: IngestFileArgs): Promise<IngestFileResult> {
  const startTime = Date.now();
  const trigger_source = args.trigger_source ?? "manual";
  const engagementId = args.engagement_id;

  // Pre-flight: control must exist and belong to this engagement.
  // Short scoped read — fails loud if control is invisible (wrong engagement or missing).
  let control: ControlRow;
  try {
    const c = await withEngagementScope(engagementId, (tx) => loadControl(tx, args.control_id));
    if (!c) {
      return {
        status: "failed",
        filename: args.filename,
        evidence_file_id: null,
        job_run_id: null,
        duration_ms: Date.now() - startTime,
        error: `Control ${args.control_id} not found`,
      };
    }
    control = c;
  } catch (err) {
    return {
      status: "failed",
      filename: args.filename,
      evidence_file_id: null,
      job_run_id: null,
      duration_ms: Date.now() - startTime,
      error: (err as Error).message,
    };
  }

  // job_runs is a system table — stays on the service_role client.
  let job;
  try {
    job = await startJobRun({
      function_name: FUNCTION_NAME,
      trigger_source,
      payload: {
        control_id: args.control_id,
        file_path: args.file_path,
        filename: args.filename,
        google_drive_file_id: args.google_drive_file_id,
        sync_run_id: args.sync_run_id,
      },
      engagement_id: engagementId,
    });
  } catch (err) {
    return {
      status: "failed",
      filename: args.filename,
      evidence_file_id: null,
      job_run_id: null,
      duration_ms: Date.now() - startTime,
      error: `Failed to start job_run: ${(err as Error).message}`,
    };
  }

  let evidenceFileId: string | null = null;

  try {
    const fileHash = await sha256Hex(args.file_bytes);

    // File-level dedupe (scoped read).
    const existing = await withEngagementScope(
      engagementId,
      (tx) => findExistingFile(tx, engagementId, fileHash),
    );
    if (existing) {
      // Always (re)link the file to this control.
      await withEngagementScope(
        engagementId,
        (tx) => linkFileToControl(tx, existing.id, args.control_id),
      );
      // Only a COMPLETE prior ingestion (one that actually produced extracted_evidence)
      // is a true dedupe. A PARTIAL row — created before extraction by a run that was
      // killed mid-ingest — must be re-extracted, not skipped (otherwise it's stuck
      // forever: the row exists so dedupe skips it, but it has no extracted content).
      const completed = await withEngagementScope(engagementId, async (tx) => {
        const rows = await tx<{ n: number }[]>`
          select count(*)::int as n from extracted_evidence where evidence_file_id = ${existing.id}
        `;
        return rows[0].n > 0;
      });
      if (completed) {
        await completeJobRun({
          handle: job,
          result: { skipped: true, skip_reason: "file_dedupe", existing_file_id: existing.id },
        });
        return {
          status: "skipped",
          filename: args.filename,
          evidence_file_id: null,
          existing_file_id: existing.id,
          skip_reason: "file_dedupe",
          job_run_id: job.id,
          duration_ms: Date.now() - startTime,
          file_size_bytes: args.file_bytes.length,
          storage_path: args.file_path,
        };
      }
      // Partial row — reuse it and fall through to (re-)extraction below.
      evidenceFileId = existing.id;
    }

    // Spreadsheets aren't natively extractable — convert .xlsx/.xls to CSV up front
    // and run them through the CSV extractor. The ORIGINAL bytes still drive the
    // file_hash dedupe + stored file size above; only extraction uses the CSV.
    const rawExt = args.filename.toLowerCase().split(".").pop() ?? "";
    let workingFilename = args.filename;
    let workingBytes = args.file_bytes;
    if (rawExt === "xlsx" || rawExt === "xls") {
      workingFilename = args.filename.replace(/\.(xlsx|xls)$/i, ".csv");
      workingBytes = new TextEncoder().encode(xlsxToCsv(args.file_bytes));
    }

    const fileType = await detectFileType(workingFilename, workingBytes);

    // Insert the evidence_files row (scoped write) — unless we're reusing an existing
    // PARTIAL row (set in the dedupe block above), in which case we keep its id and
    // just re-run the extraction below.
    if (!evidenceFileId) {
      const evidenceFile = await withEngagementScope(
        engagementId,
        (tx) =>
          insertOrGetEvidenceFile(tx, {
            engagement_id: engagementId,
            file_hash: fileHash,
            filename: args.filename,
            file_type: fileType,
            file_size_bytes: args.file_bytes.length,
            mime_type: mimeTypeFor(args.filename),
            storage_path: args.file_path,
          }),
      );
      evidenceFileId = evidenceFile.id;

      if (!evidenceFile.inserted) {
        // A concurrent worker won the file-hash insert. Always attach the shared
        // row to this control, then reuse its extraction if it already landed.
        const completed = await withEngagementScope(engagementId, async (tx) => {
          await linkFileToControl(tx, evidenceFile.id, args.control_id);
          const rows = await tx<{ n: number }[]>`
            select count(*)::int as n
            from extracted_evidence
            where evidence_file_id = ${evidenceFile.id}
          `;
          return rows[0].n > 0;
        });
        if (completed) {
          await completeJobRun({
            handle: job,
            result: {
              skipped: true,
              skip_reason: "file_dedupe",
              existing_file_id: evidenceFile.id,
              concurrent_insert: true,
            },
          });
          return {
            status: "skipped",
            filename: args.filename,
            evidence_file_id: null,
            existing_file_id: evidenceFile.id,
            skip_reason: "file_dedupe",
            job_run_id: job.id,
            duration_ms: Date.now() - startTime,
            file_size_bytes: args.file_bytes.length,
            storage_path: args.file_path,
          };
        }
      }
    }

    // prompts is a system table — load on service_role.
    const primaryPrompt = await loadActivePrompt(primaryPromptKeyFor(fileType));

    // Extraction-level dedupe (scoped read).
    const existingExtraction = await withEngagementScope(
      engagementId,
      (tx) => findExistingExtraction(tx, evidenceFileId!, primaryPrompt.prompt_id),
    );
    if (existingExtraction) {
      await withEngagementScope(engagementId, async (tx) => {
        await linkFileToControl(tx, evidenceFileId!, args.control_id);
        await updateEvidenceFileStatus(tx, evidenceFileId!, "extracted", null);
      });
      await completeJobRun({
        handle: job,
        result: {
          skipped: true,
          skip_reason: "extraction_dedupe",
          evidence_file_id: evidenceFileId,
          existing_extraction_id: existingExtraction.id,
        },
      });
      return {
        status: "skipped",
        filename: args.filename,
        evidence_file_id: evidenceFileId,
        existing_extraction_id: existingExtraction.id,
        skip_reason: "extraction_dedupe",
        job_run_id: job.id,
        duration_ms: Date.now() - startTime,
        file_type: fileType,
        file_size_bytes: args.file_bytes.length,
        storage_path: args.file_path,
      };
    }

    // TSC string for extraction context (scoped read).
    const tscsString = await withEngagementScope(
      engagementId,
      (tx) => loadTscString(tx, control.id),
    );

    const ctx = {
      control_description: control.control_description ?? "",
      expected_procedures: control.refined_expected_procedure ?? control.expected_procedures ?? "",
      tscs: tscsString,
      filename: args.filename,
    };
    if (!ctx.control_description) {
      throw new Error("Control has no original control_description");
    }
    if (!ctx.expected_procedures) {
      throw new Error("Control has no expected_procedures (refined or raw)");
    }

    // Large PDFs are the one extraction class that can exceed an Edge Function
    // isolate's wall-clock/memory budget. When Make is configured AND this call
    // belongs to a durable sync run, dispatch the binary externally and return.
    // Everything after extraction (embedding, scoped DB writes, linking, audit
    // sequencing) remains inside Supabase and is performed by the callback.
    if (
      shouldUseMakeExtraction(fileType, args.sync_run_id) &&
      (args.google_drive_file_id || args.external_download_url)
    ) {
      // Make owns the large-PDF iterator and Array aggregator. Supabase sends both
      // authoritative prompt-library rows so Make does not carry stale prompt text.
      // Step 2 produces the final document-level JSON and therefore supplies the
      // extractor_prompt_id stored by the callback.
      const [step1Prompt, step2Prompt] = await Promise.all([
        loadActivePrompt("extractor_pdf_chunk"),
        loadActivePrompt("extractor_pdf_aggregator"),
      ]);
      const external = await dispatchMakeExtraction({
        sync_run_id: args.sync_run_id!,
        engagement_id: engagementId,
        control_uuid: control.id,
        control_code: control.control_id,
        evidence_file_id: evidenceFileId,
        filename: args.filename,
        storage_path: args.file_path,
        google_drive_file_id: args.google_drive_file_id,
        download_url: args.external_download_url,
        file_size_bytes: args.file_bytes.length,
        context: ctx,
        step_1_prompt: step1Prompt,
        step_2_prompt: step2Prompt,
      });

      await completeJobRun({
        handle: job,
        result: {
          queued_external: true,
          provider: "make",
          external_job_id: external.job_id,
          sync_run_id: args.sync_run_id,
          evidence_file_id: evidenceFileId,
          file_type: fileType,
          file_size_bytes: args.file_bytes.length,
        },
      });
      return {
        status: "queued",
        filename: args.filename,
        evidence_file_id: evidenceFileId,
        external_job_id: external.job_id,
        job_run_id: job.id,
        duration_ms: Date.now() - startTime,
        file_type: fileType,
        file_size_bytes: args.file_bytes.length,
        storage_path: args.file_path,
      };
    }

    // Claude extraction + OpenAI embedding happen outside any transaction.
    const extraction = await extractByType({ fileType, bytes: workingBytes, context: ctx });
    const embeddingSource = pickEmbeddingSource(args.filename, extraction.extracted_content);
    const { embedding, tokens: embeddingTokens } = await generateEmbedding(embeddingSource);

    // Final atomic scoped write: insert extracted_evidence + link + mark extracted.
    // The trg_extracted_evidence_engagement trigger auto-derives engagement_id from
    // the evidence_files parent, so we omit it here.
    const extractedWrite = await withEngagementScope(engagementId, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into extracted_evidence
          (evidence_file_id, extractor_prompt_id, extracted_content, raw_extracted_text,
           scratchpad, embedding, input_tokens, output_tokens)
        values
          (${evidenceFileId}, ${extraction.extractor_prompt_id},
           ${tx.json(extraction.extracted_content as Parameters<typeof tx.json>[0])},
           ${extraction.raw_extracted_text ?? null},
           ${extraction.scratchpad ?? null},
           ${JSON.stringify(embedding)},
           ${extraction.total_input_tokens}, ${extraction.total_output_tokens})
        on conflict (evidence_file_id, extractor_prompt_id) do nothing
        returning id
      `;
      const persisted = row ?? (await findExistingExtraction(
        tx,
        evidenceFileId!,
        extraction.extractor_prompt_id,
      ));
      if (!persisted) throw new Error("Failed to persist or reuse extracted_evidence");
      await linkFileToControl(tx, evidenceFileId!, args.control_id);
      await updateEvidenceFileStatus(tx, evidenceFileId!, "extracted", null);
      return { id: persisted.id, inserted: !!row };
    });

    if (!extractedWrite.inserted) {
      await completeJobRun({
        handle: job,
        result: {
          skipped: true,
          skip_reason: "extraction_dedupe",
          evidence_file_id: evidenceFileId,
          existing_extraction_id: extractedWrite.id,
          concurrent_extraction: true,
        },
      });
      return {
        status: "skipped",
        filename: args.filename,
        evidence_file_id: evidenceFileId,
        existing_extraction_id: extractedWrite.id,
        skip_reason: "extraction_dedupe",
        job_run_id: job.id,
        duration_ms: Date.now() - startTime,
        file_type: fileType,
        file_size_bytes: args.file_bytes.length,
        storage_path: args.file_path,
      };
    }

    await completeJobRun({
      handle: job,
      result: {
        evidence_file_id: evidenceFileId,
        extracted_evidence_id: extractedWrite.id,
        file_type: fileType,
        file_size_bytes: args.file_bytes.length,
        extractor_prompt_id: extraction.extractor_prompt_id,
        input_tokens: extraction.total_input_tokens,
        output_tokens: extraction.total_output_tokens,
        embedding_tokens: embeddingTokens,
      },
    });

    // Full extracted_content JSON for the Evidence Log "Extracted_Data" column.
    const extractedSummary = JSON.stringify(extraction.extracted_content);

    return {
      status: "extracted",
      filename: args.filename,
      evidence_file_id: evidenceFileId,
      extracted_evidence_id: extractedWrite.id,
      job_run_id: job.id,
      duration_ms: Date.now() - startTime,
      tokens: {
        input: extraction.total_input_tokens,
        output: extraction.total_output_tokens,
        embedding: embeddingTokens,
      },
      file_type: fileType,
      file_size_bytes: args.file_bytes.length,
      storage_path: args.file_path,
      extracted_summary: extractedSummary,
      scratchpad: typeof extraction.scratchpad === "string" ? extraction.scratchpad : null,
    };
  } catch (err) {
    const e = err as Error;
    if (evidenceFileId) {
      // Best-effort status update on failure — don't let this throw suppress the real error.
      await withEngagementScope(
        engagementId,
        (tx) => markEvidenceFileFailedUnlessExtracted(tx, evidenceFileId!, e.message),
      ).catch((se) => console.error(`Failed to mark evidence_file failed: ${se.message}`));
    }
    await failJobRun({ handle: job, error_message: e.message, error_stack: e.stack });
    return {
      status: "failed",
      filename: args.filename,
      evidence_file_id: evidenceFileId,
      job_run_id: job.id,
      duration_ms: Date.now() - startTime,
      error: e.message,
    };
  }
}
