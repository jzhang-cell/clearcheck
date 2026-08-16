// make-extraction-callback — receives structured large-PDF extraction output
// from Make.com, performs the normal Supabase-side embedding/database writes,
// and resumes sync-control-evidence when every Make job in the sync is done.
//
// Contract:
//   POST /functions/v1/make-extraction-callback
//   header: x-make-secret: <MAKE_WEBHOOK_SECRET>
//   body: {
//     job_id: uuid,
//     status: "completed" | "failed",
//     extracted_content?: object | JSON string,
//     raw_extracted_text?: string,
//     scratchpad?: string | null,
//     input_tokens?: integer,
//     output_tokens?: integer,
//     provider_execution_id?: string,
//     provider_execution_url?: string,
//     error?: string
//   }
import { getServiceClient } from "../_shared/supabase-client.ts";
import { withEngagementScope } from "../_shared/scoped-db.ts";
import { completeJobRun, failJobRun, startJobRun } from "../_shared/job-run.ts";
import { generateEmbedding } from "../_shared/openai-client.ts";
import { patchAirtableRecord } from "../_shared/airtable.ts";
import { fetchWithRetry } from "../_shared/retry.ts";
import {
  type ExternalExtractionStatus,
  summarizeExternalJobs,
} from "../_shared/external-extraction.ts";
import {
  asOptionalProviderExecutionId,
  asOptionalProviderExecutionUrl,
} from "../_shared/provider-execution.ts";

const FUNCTION_NAME = "make-extraction-callback";
const AIRTABLE_CONTROLS_TABLE_ID = "tblZrxDzOKd9FJkbC";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CallbackPayload {
  job_id?: unknown;
  status?: unknown;
  extracted_content?: unknown;
  raw_extracted_text?: unknown;
  scratchpad?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  provider_execution_id?: unknown;
  provider_execution_url?: unknown;
  error?: unknown;
}

interface ExternalJobRow {
  id: string;
  sync_run_id: string;
  engagement_id: string;
  control_uuid: string;
  evidence_file_id: string;
  extractor_prompt_id: string;
  filename: string;
  status: ExternalExtractionStatus;
  attempts: number;
  updated_at: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function asNonNegativeInteger(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function normalizeExtractedContent(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error("'extracted_content' is a string but is not valid JSON");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("'extracted_content' must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function embeddingSource(filename: string, content: Record<string, unknown>): string {
  const documentSummary = content.document_summary;
  if (typeof documentSummary === "string" && documentSummary.trim()) return documentSummary;
  const summary = content.summary;
  if (typeof summary === "string" && summary.trim()) return summary;
  return `${filename}\n\n${JSON.stringify(content).slice(0, 1000)}`;
}

async function setControlStatus(job: ExternalJobRow, message: string): Promise<void> {
  try {
    const meta = await withEngagementScope(job.engagement_id, async (tx) => {
      const rows = await tx<{ airtable_record_id: string | null; airtable_base: string | null }[]>`
        select c.airtable_record_id, e.airtable_base
        from controls c
        join engagements e on e.id = c.engagement_id
        where c.id = ${job.control_uuid}
      `;
      return rows[0] ?? null;
    });
    if (!meta) return;
    await patchAirtableRecord({
      baseId: meta.airtable_base,
      tableId: AIRTABLE_CONTROLS_TABLE_ID,
      recordId: meta.airtable_record_id,
      fields: { "ClearCheck 💬": message },
    });
  } catch (error) {
    console.warn(`Make callback Airtable status failed: ${(error as Error).message}`);
  }
}

async function markExternalFailure(
  job: ExternalJobRow,
  message: string,
  providerExecutionId: string | null,
  providerExecutionUrl: string | null,
): Promise<boolean> {
  const supabase = getServiceClient();
  const now = new Date().toISOString();
  const { data: claimed, error } = await supabase.from("external_extraction_jobs").update({
    status: "failed",
    provider_execution_id: providerExecutionId,
    provider_execution_url: providerExecutionUrl,
    error_message: message,
    completed_at: now,
    updated_at: now,
  }).eq("id", job.id).in("status", ["queued", "processing"]).select("id").maybeSingle();
  if (error) throw new Error(`Failed to record Make failure: ${error.message}`);
  // A completed callback may be embedding at this exact moment. Its success is
  // authoritative; a late failure delivery must not fail the whole sync.
  if (!claimed) return false;
  await supabase.from("evidence_sync_runs").update({
    status: "failed",
    error_message: message,
    completed_at: now,
    updated_at: now,
  }).eq("id", job.sync_run_id).neq("status", "completed");
  await withEngagementScope(job.engagement_id, (tx) =>
    tx`
      update evidence_files
      set status = 'failed', error_message = ${message}
      where id = ${job.evidence_file_id}
    `);
  await setControlStatus(job, `❌ Large-PDF extraction failed: ${message}`);
  return true;
}

async function resumeSyncIfReady(job: ExternalJobRow): Promise<{
  ready: boolean;
  resumed: boolean;
  state: string;
}> {
  const supabase = getServiceClient();
  const { data: rows, error } = await supabase
    .from("external_extraction_jobs")
    .select("status,error_message")
    .eq("sync_run_id", job.sync_run_id);
  if (error) throw new Error(`Failed to check sibling Make jobs: ${error.message}`);
  const summary = summarizeExternalJobs(
    (rows ?? []) as { status: ExternalExtractionStatus; error_message: string | null }[],
  );
  if (summary.state !== "ready") {
    return { ready: false, resumed: false, state: summary.state };
  }

  // Claim the resume only from waiting_external. If the original sync is still
  // dispatching, it re-checks after publishing waiting_external and closes that
  // race itself. If another callback already claimed it, this update returns 0.
  const { data: claimed, error: claimError } = await supabase
    .from("evidence_sync_runs")
    .update({ status: "resuming", updated_at: new Date().toISOString() })
    .eq("id", job.sync_run_id)
    .eq("status", "waiting_external")
    .select("id")
    .maybeSingle();
  if (claimError) throw new Error(`Failed to claim sync resume: ${claimError.message}`);
  if (!claimed) return { ready: true, resumed: false, state: "ready" };

  const base = Deno.env.get("SUPABASE_URL");
  const sharedSecret = Deno.env.get("AUDIT_SHARED_SECRET");
  if (!base || !sharedSecret) {
    throw new Error("Cannot resume sync: SUPABASE_URL or AUDIT_SHARED_SECRET is not set");
  }

  try {
    const response = await fetchWithRetry(
      `${base.replace(/\/$/, "")}/functions/v1/sync-control-evidence`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-audit-secret": sharedSecret,
        },
        body: JSON.stringify({
          control_uuid: job.control_uuid,
          engagement_id: job.engagement_id,
          internal_resume: true,
          sync_run_id: job.sync_run_id,
          trigger_source: "make-callback",
        }),
      },
      { label: "sync-control-evidence resume" },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `sync-control-evidence resume returned HTTP ${response.status}: ${body.slice(0, 300)}`,
      );
    }
    return { ready: true, resumed: true, state: "ready" };
  } catch (error) {
    // Put the run back into a recoverable waiting state. A manual Run V3 click
    // will reuse this live row and finish without re-extracting the PDF.
    await supabase.from("evidence_sync_runs").update({
      status: "waiting_external",
      error_message: (error as Error).message,
      updated_at: new Date().toISOString(),
    }).eq("id", job.sync_run_id).eq("status", "resuming");
    await setControlStatus(
      job,
      "⚠️ Large PDF is ready, but ClearCheck could not resume automatically. Press Run V3 again.",
    );
    throw error;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const expectedSecret = Deno.env.get("MAKE_WEBHOOK_SECRET");
  if (!expectedSecret) {
    return jsonResponse({ error: "Server misconfiguration: MAKE_WEBHOOK_SECRET not set" }, 500);
  }
  if (req.headers.get("x-make-secret") !== expectedSecret) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let payload: CallbackPayload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (typeof payload.job_id !== "string" || !UUID_RE.test(payload.job_id)) {
    return jsonResponse({ error: "Missing or invalid 'job_id'" }, 400);
  }
  if (payload.status !== "completed" && payload.status !== "failed") {
    return jsonResponse({ error: "'status' must be 'completed' or 'failed'" }, 400);
  }
  const providerExecutionId = asOptionalProviderExecutionId(payload.provider_execution_id);
  let providerExecutionUrl: string | null;
  try {
    providerExecutionUrl = asOptionalProviderExecutionUrl(payload.provider_execution_url);
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 400);
  }

  const supabase = getServiceClient();
  const { data: loaded, error: loadError } = await supabase
    .from("external_extraction_jobs")
    .select(
      "id,sync_run_id,engagement_id,control_uuid,evidence_file_id,extractor_prompt_id," +
        "filename,status,attempts,updated_at",
    )
    .eq("id", payload.job_id)
    .maybeSingle();
  if (loadError) return jsonResponse({ error: loadError.message }, 500);
  if (!loaded) return jsonResponse({ error: "External extraction job not found" }, 404);
  const job = loaded as unknown as ExternalJobRow;

  if (job.status === "completed") {
    try {
      const resume = await resumeSyncIfReady(job);
      return jsonResponse({
        success: true,
        idempotent: true,
        job_id: job.id,
        sync_ready: resume.ready,
        sync_resumed: resume.resumed,
      });
    } catch (error) {
      return jsonResponse({ error: (error as Error).message, retryable: true }, 500);
    }
  }
  if (job.status === "failed" && payload.status === "failed") {
    return jsonResponse({ success: true, idempotent: true, job_id: job.id, status: "failed" });
  }
  if (job.status === "failed" && payload.status === "completed") {
    return jsonResponse({ error: "External extraction job is already failed" }, 409);
  }
  if (job.status === "completing") {
    const completingAgeMs = Date.now() - Date.parse(job.updated_at);
    const configuredLeaseMs = Number(Deno.env.get("MAKE_CALLBACK_LEASE_MS") ?? "300000");
    const leaseMs = Number.isFinite(configuredLeaseMs)
      ? Math.max(60_000, configuredLeaseMs)
      : 300_000;
    if (!Number.isFinite(completingAgeMs) || completingAgeMs < leaseMs) {
      return jsonResponse({ accepted: true, job_id: job.id, status: "completing" }, 202);
    }
    const { data: reclaimed, error: reclaimError } = await supabase
      .from("external_extraction_jobs")
      .update({
        status: "processing",
        error_message: "Reclaimed after a stale callback completion lease",
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", "completing")
      .eq("updated_at", job.updated_at)
      .select("id")
      .maybeSingle();
    if (reclaimError) return jsonResponse({ error: reclaimError.message }, 500);
    if (!reclaimed) {
      return jsonResponse({ accepted: true, job_id: job.id, status: "completing" }, 202);
    }
    job.status = "processing";
  }

  let callbackJob;
  try {
    callbackJob = await startJobRun({
      function_name: FUNCTION_NAME,
      trigger_source: "make",
      engagement_id: job.engagement_id,
      payload: {
        external_job_id: job.id,
        sync_run_id: job.sync_run_id,
        control_uuid: job.control_uuid,
        provider_status: payload.status,
      },
    });
  } catch (error) {
    return jsonResponse(
      { error: `Failed to start callback job: ${(error as Error).message}` },
      500,
    );
  }

  if (payload.status === "failed") {
    const message = typeof payload.error === "string" && payload.error.trim()
      ? payload.error.trim().slice(0, 1000)
      : "Make reported an extraction failure";
    try {
      const recorded = await markExternalFailure(
        job,
        message,
        providerExecutionId,
        providerExecutionUrl,
      );
      await completeJobRun({
        handle: callbackJob,
        result: { external_job_id: job.id, provider_status: "failed", recorded },
      });
      return jsonResponse({
        success: true,
        idempotent: !recorded,
        job_id: job.id,
        status: recorded ? "failed" : "completion_in_progress",
      }, recorded ? 200 : 202);
    } catch (error) {
      await failJobRun({
        handle: callbackJob,
        error_message: (error as Error).message,
        error_stack: (error as Error).stack,
      });
      return jsonResponse({ error: (error as Error).message }, 500);
    }
  }

  // Atomically claim this callback attempt. Duplicate Make deliveries either
  // see completed above or get a harmless 202 while the first one is embedding.
  const claimNow = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from("external_extraction_jobs")
    .update({
      status: "completing",
      attempts: job.attempts + 1,
      provider_execution_id: providerExecutionId,
      provider_execution_url: providerExecutionUrl,
      error_message: null,
      updated_at: claimNow,
    })
    .eq("id", job.id)
    .in("status", ["queued", "processing"])
    .select("id")
    .maybeSingle();
  if (claimError) {
    await failJobRun({ handle: callbackJob, error_message: claimError.message });
    return jsonResponse({ error: claimError.message }, 500);
  }
  if (!claimed) {
    await completeJobRun({
      handle: callbackJob,
      result: { external_job_id: job.id, duplicate_delivery: true },
    });
    return jsonResponse({ accepted: true, job_id: job.id, status: "completing" }, 202);
  }

  try {
    const extractedContent = normalizeExtractedContent(payload.extracted_content);
    const rawText = typeof payload.raw_extracted_text === "string"
      ? payload.raw_extracted_text
      : JSON.stringify(extractedContent);
    const scratchpad = typeof payload.scratchpad === "string" ? payload.scratchpad : null;
    const inputTokens = asNonNegativeInteger(payload.input_tokens);
    const outputTokens = asNonNegativeInteger(payload.output_tokens);
    const { embedding, tokens: embeddingTokens } = await generateEmbedding(
      embeddingSource(job.filename, extractedContent),
    );

    const extractedEvidenceId = await withEngagementScope(job.engagement_id, async (tx) => {
      const existing = await tx<{ id: string }[]>`
        select id from extracted_evidence
        where evidence_file_id = ${job.evidence_file_id}
          and extractor_prompt_id = ${job.extractor_prompt_id}
          and extracted_content is not null
        limit 1
      `;
      let id = existing[0]?.id;
      if (!id) {
        const inserted = await tx<{ id: string }[]>`
          insert into extracted_evidence
            (evidence_file_id, extractor_prompt_id, extracted_content, raw_extracted_text,
             scratchpad, embedding, input_tokens, output_tokens)
          values
            (${job.evidence_file_id}, ${job.extractor_prompt_id},
             ${tx.json(extractedContent as Parameters<typeof tx.json>[0])},
             ${rawText}, ${scratchpad}, ${JSON.stringify(embedding)},
             ${inputTokens}, ${outputTokens})
          on conflict (evidence_file_id, extractor_prompt_id) do nothing
          returning id
        `;
        id = inserted[0]?.id;
        if (!id) {
          const raced = await tx<{ id: string }[]>`
            select id from extracted_evidence
            where evidence_file_id = ${job.evidence_file_id}
              and extractor_prompt_id = ${job.extractor_prompt_id}
              and extracted_content is not null
            limit 1
          `;
          id = raced[0]?.id;
        }
      }
      if (!id) throw new Error("Failed to create extracted_evidence row");
      await tx`
        insert into evidence_control_links (evidence_file_id, control_id)
        values (${job.evidence_file_id}, ${job.control_uuid})
        on conflict (evidence_file_id, control_id) do nothing
      `;
      await tx`
        update evidence_files
        set status = 'extracted', error_message = null
        where id = ${job.evidence_file_id}
      `;
      return id;
    });

    const completedAt = new Date().toISOString();
    const { error: finishError } = await supabase
      .from("external_extraction_jobs")
      .update({
        status: "completed",
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        completed_at: completedAt,
        updated_at: completedAt,
        error_message: null,
      })
      .eq("id", job.id);
    if (finishError) throw new Error(`Failed to complete external job: ${finishError.message}`);

    const resume = await resumeSyncIfReady(job);
    await completeJobRun({
      handle: callbackJob,
      result: {
        external_job_id: job.id,
        extracted_evidence_id: extractedEvidenceId,
        embedding_tokens: embeddingTokens,
        sync_ready: resume.ready,
        sync_resumed: resume.resumed,
      },
    });
    return jsonResponse({
      success: true,
      job_id: job.id,
      extracted_evidence_id: extractedEvidenceId,
      sync_run_id: job.sync_run_id,
      sync_ready: resume.ready,
      sync_resumed: resume.resumed,
    });
  } catch (error) {
    // Keep the provider job retryable. Make can resend the completed callback;
    // if the DB insert already landed, the idempotent query above reuses it.
    await supabase.from("external_extraction_jobs").update({
      status: "processing",
      error_message: `Callback attempt failed: ${(error as Error).message}`,
      updated_at: new Date().toISOString(),
    }).eq("id", job.id).eq("status", "completing");
    await failJobRun({
      handle: callbackJob,
      error_message: (error as Error).message,
      error_stack: (error as Error).stack,
    });
    return jsonResponse({ error: (error as Error).message, retryable: true }, 500);
  }
});
