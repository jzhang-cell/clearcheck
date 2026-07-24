import { getServiceClient } from "./supabase-client.ts";
import type { ExtractionContext } from "./extract-by-type.ts";
import type { ActivePrompt } from "./types.ts";
import type { FileType } from "./file-type.ts";

export type ExternalExtractionStatus =
  | "queued"
  | "processing"
  | "completing"
  | "completed"
  | "failed";

export interface ExternalJobSummary {
  state: "none" | "waiting" | "ready" | "failed";
  total: number;
  waiting: number;
  completed: number;
  failed: number;
  errors: string[];
}

export function summarizeExternalJobs(
  jobs: { status: ExternalExtractionStatus; error_message?: string | null }[],
): ExternalJobSummary {
  const waiting =
    jobs.filter((j) =>
      j.status === "queued" || j.status === "processing" || j.status === "completing"
    ).length;
  const completed = jobs.filter((j) => j.status === "completed").length;
  const failedJobs = jobs.filter((j) => j.status === "failed");
  const failed = failedJobs.length;
  const state = jobs.length === 0
    ? "none"
    : failed > 0
    ? "failed"
    : waiting > 0
    ? "waiting"
    : "ready";
  return {
    state,
    total: jobs.length,
    waiting,
    completed,
    failed,
    errors: failedJobs
      .map((j) => j.error_message?.trim())
      .filter((v): v is string => Boolean(v)),
  };
}

export function makeExtractionEnabled(): boolean {
  return Boolean(
    Deno.env.get("MAKE_LARGE_PDF_WEBHOOK_URL") && Deno.env.get("MAKE_WEBHOOK_SECRET"),
  );
}

// A healthy 100+ page Make extraction has taken roughly 40 minutes in
// production, so the stale cutoff must be much longer than an Edge Function
// timeout. Two hours closes genuinely abandoned jobs without killing slow but
// valid SOC-report processing. Both manual Run V3 recovery and the scheduled
// sweeper use this same value.
export function makeExternalStaleMs(): number {
  const configured = Number(Deno.env.get("MAKE_EXTERNAL_STALE_MS") ?? "7200000");
  return Number.isFinite(configured) ? Math.max(2 * 60 * 60_000, configured) : 2 * 60 * 60_000;
}

export function shouldUseMakeExtraction(fileType: FileType, syncRunId?: string): boolean {
  return fileType === "pdf_large" && Boolean(syncRunId) && makeExtractionEnabled();
}

export interface DispatchMakeExtractionArgs {
  sync_run_id: string;
  engagement_id: string;
  control_uuid: string;
  control_code: string;
  evidence_file_id: string;
  filename: string;
  storage_path: string;
  google_drive_file_id?: string;
  download_url?: string;
  file_size_bytes: number;
  context: ExtractionContext;
  step_1_prompt: ActivePrompt;
  step_2_prompt: ActivePrompt;
}

export interface DispatchMakeExtractionResult {
  job_id: string;
  status: ExternalExtractionStatus;
}

interface ExternalJobRow {
  id: string;
  status: ExternalExtractionStatus;
  error_message: string | null;
}

export interface ExternalFileLocator {
  source: "google_drive" | "download_url";
  google_drive_file_id: string | null;
  download_url: string | null;
}

// Prefer the original Drive object when available. Airtable-uploaded evidence
// has no Drive ID, so sync supplies a time-limited URL for the copy already
// stored in Supabase Storage.
export function externalFileLocator(args: {
  google_drive_file_id?: string;
  download_url?: string;
}): ExternalFileLocator {
  const driveId = args.google_drive_file_id?.trim() ?? "";
  if (driveId) {
    return {
      source: "google_drive",
      google_drive_file_id: driveId,
      download_url: null,
    };
  }

  const downloadUrl = args.download_url?.trim() ?? "";
  if (downloadUrl) {
    let parsed: URL;
    try {
      parsed = new URL(downloadUrl);
    } catch {
      throw new Error("External extraction download_url is not a valid URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("External extraction download_url must use HTTP or HTTPS");
    }
    return {
      source: "download_url",
      google_drive_file_id: null,
      download_url: downloadUrl,
    };
  }

  throw new Error("External extraction requires a Google Drive file ID or download URL");
}

async function findExistingJob(
  args: DispatchMakeExtractionArgs,
): Promise<ExternalJobRow | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("external_extraction_jobs")
    .select("id,status,error_message")
    .eq("sync_run_id", args.sync_run_id)
    .eq("evidence_file_id", args.evidence_file_id)
    // Step 2 produces the final document-level JSON stored in
    // extracted_evidence, so it is the authoritative extractor prompt FK.
    .eq("extractor_prompt_id", args.step_2_prompt.prompt_id)
    .maybeSingle();
  if (error) throw new Error(`Failed to read external extraction job: ${error.message}`);
  return data as ExternalJobRow | null;
}

/**
 * Queue one large PDF in Make. The raw file has already been uploaded to the
 * private `evidence` bucket for ClearCheck's own records. Drive-sourced files
 * keep using the original Drive ID. Airtable-sourced files use a time-limited
 * URL for only this Storage object; Make never receives a service-role key.
 *
 * The POST is intentionally sent once. Retrying an ambiguous webhook timeout
 * can launch duplicate Make executions. The durable queued row makes a failed
 * dispatch visible and safe to retry with a new sync run.
 */
export async function dispatchMakeExtraction(
  args: DispatchMakeExtractionArgs,
): Promise<DispatchMakeExtractionResult> {
  const webhookUrl = Deno.env.get("MAKE_LARGE_PDF_WEBHOOK_URL");
  const secret = Deno.env.get("MAKE_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!webhookUrl || !secret || !supabaseUrl) {
    throw new Error(
      "Make large-PDF extraction is not configured (MAKE_LARGE_PDF_WEBHOOK_URL, " +
        "MAKE_WEBHOOK_SECRET, and SUPABASE_URL are required)",
    );
  }

  const existing = await findExistingJob(args);
  if (existing) {
    if (existing.status === "failed") {
      throw new Error(existing.error_message ?? "The existing Make extraction job failed");
    }
    return { job_id: existing.id, status: existing.status };
  }

  const supabase = getServiceClient();
  const { data: inserted, error: insertError } = await supabase
    .from("external_extraction_jobs")
    .insert({
      sync_run_id: args.sync_run_id,
      engagement_id: args.engagement_id,
      control_uuid: args.control_uuid,
      evidence_file_id: args.evidence_file_id,
      extractor_prompt_id: args.step_2_prompt.prompt_id,
      provider: "make",
      status: "queued",
      filename: args.filename,
      storage_path: args.storage_path,
    })
    .select("id,status,error_message")
    .single();

  if (insertError) {
    // A concurrent ingest may have won the unique-key race. Reuse its durable
    // job instead of firing a second Make scenario.
    if (insertError.code === "23505") {
      const raced = await findExistingJob(args);
      if (raced && raced.status !== "failed") {
        return { job_id: raced.id, status: raced.status };
      }
    }
    throw new Error(`Failed to create external extraction job: ${insertError.message}`);
  }

  const job = inserted as ExternalJobRow;
  const fileLocator = externalFileLocator(args);
  const callbackUrl = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/make-extraction-callback`;
  const controller = new AbortController();
  const configuredTimeoutMs = Number(Deno.env.get("MAKE_WEBHOOK_TIMEOUT_MS") ?? "15000");
  const timeoutMs = Number.isFinite(configuredTimeoutMs)
    ? Math.max(5_000, configuredTimeoutMs)
    : 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-clearcheck-secret": secret,
      },
      body: JSON.stringify({
        // Keep existing Drive jobs on contract 3 so the already-live Make route
        // remains backward compatible. Contract 4 adds the download-URL source
        // used by Airtable V3_Evidence.
        contract_version: fileLocator.source === "google_drive" ? 3 : 4,
        job_id: job.id,
        sync_run_id: args.sync_run_id,
        file: {
          evidence_file_id: args.evidence_file_id,
          source: fileLocator.source,
          google_drive_file_id: fileLocator.google_drive_file_id,
          download_url: fileLocator.download_url,
          filename: args.filename,
          size_bytes: args.file_size_bytes,
        },
        control: {
          uuid: args.control_uuid,
          code: args.control_code,
          description: args.context.control_description,
          expected_procedures: args.context.expected_procedures,
          tscs: args.context.tscs,
        },
        extraction: {
          strategy: "chunk_then_aggregate",
          step_1: {
            name: "extractor_pdf_big_Step_1",
            purpose: "Run once for each PDF text chunk",
            prompt_id: args.step_1_prompt.prompt_id,
            prompt_key: args.step_1_prompt.prompt_key,
            prompt_version: args.step_1_prompt.version,
            model: args.step_1_prompt.model,
            system_prompt: args.step_1_prompt.system_prompt,
            user_prompt_template: args.step_1_prompt.user_prompt_template,
            max_tokens: args.step_1_prompt.max_tokens,
            template_variables: [
              "control_description",
              "tscs",
              "expected_procedures",
              "evidence_text",
              "chunk_number",
              "total_chunks",
            ],
          },
          step_2: {
            name: "extractor_pdf_big_Step_2",
            purpose: "Run once after the Array aggregator",
            prompt_id: args.step_2_prompt.prompt_id,
            prompt_key: args.step_2_prompt.prompt_key,
            prompt_version: args.step_2_prompt.version,
            model: args.step_2_prompt.model,
            system_prompt: args.step_2_prompt.system_prompt,
            user_prompt_template: args.step_2_prompt.user_prompt_template,
            max_tokens: args.step_2_prompt.max_tokens,
            template_variables: [
              "control_description",
              "tscs",
              "expected_procedures",
              "evidence_name",
              "chunk_extractions",
            ],
          },
          final_extractor_prompt_id: args.step_2_prompt.prompt_id,
          required_output: {
            extracted_content: "JSON object containing the structured evidence",
            raw_extracted_text: "string containing the model/extractor output",
            scratchpad: "optional string or null",
            input_tokens: "optional non-negative integer",
            output_tokens: "optional non-negative integer",
          },
        },
        callback: {
          url: callbackUrl,
          method: "POST",
          secret_header: "x-make-secret",
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Make webhook returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    const now = new Date().toISOString();
    const { data: transitioned, error: updateError } = await supabase
      .from("external_extraction_jobs")
      .update({ status: "processing", attempts: 1, started_at: now, updated_at: now })
      .eq("id", job.id)
      .eq("status", "queued")
      .select("status")
      .maybeSingle();
    if (updateError) {
      throw new Error(`Make accepted the job but status update failed: ${updateError.message}`);
    }
    // A very fast scenario can call back before its webhook request returns. In
    // that case the callback already moved queued → completing/completed, and
    // this conditional update correctly leaves its newer state untouched.
    if (!transitioned) {
      const current = await findExistingJob(args);
      return { job_id: job.id, status: current?.status ?? "processing" };
    }
    return { job_id: job.id, status: "processing" };
  } catch (error) {
    const aborted = (error as Error).name === "AbortError";
    const message = aborted
      ? `Make webhook did not acknowledge within ${timeoutMs}ms`
      : (error as Error).message;
    // Do not overwrite a fast callback that completed while the inbound Make
    // request was still returning (or returned a late error after callback).
    const current = await findExistingJob(args).catch(() => null);
    if (current?.status === "completing" || current?.status === "completed") {
      return { job_id: job.id, status: current.status };
    }
    const now = new Date().toISOString();
    await supabase.from("external_extraction_jobs").update({
      status: "failed",
      error_message: message,
      completed_at: now,
      updated_at: now,
    }).eq("id", job.id).in("status", ["queued", "processing"]);
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }
}
