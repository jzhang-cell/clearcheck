// sync-control-evidence — for ONE control: process Airtable V3_Evidence when
// that attachment field is non-empty; otherwise fall back to the control's
// Google Drive subfolder. Upload each file to Supabase Storage and ingest it
// (extract + embed + store) via the shared ingestFile(). Called per control by the
// Airtable [Run V3] button (ADR-012 step 4.2), BEFORE refine-control and
// run-audit — run-audit hard-fails if extracted_evidence is empty.
//
// Contract (ADR-012):
//   POST  body: { control_uuid }          // controls.id (UUID), only field
//   header: x-audit-secret
//
// Naming: control_uuid = controls.id (UUID); the display code is controls.control_id.
//   trigger_source defaults to "airtable" (override via body for debug).
//
// Fuses scripts/sync-drive-evidence.ts (Drive half, now _shared/drive-client.ts)
// with the existing ingest pipeline (_shared/ingest-file.ts).
import { getServiceClient } from "../_shared/supabase-client.ts";
import { withEngagementScope } from "../_shared/scoped-db.ts";
import { completeJobRun, failJobRun, startJobRun } from "../_shared/job-run.ts";
import { checkSharedSecret, resolveEngagementByKey } from "../_shared/auth.ts";
import { engagementSlug } from "../_shared/engagement-slug.ts";
import {
  driveDownload,
  type DriveFile,
  driveList,
  FOLDER_MIME,
  getDriveAccessToken,
} from "../_shared/drive-client.ts";
import { ingestFile } from "../_shared/ingest-file.ts";
import type { IngestFileResult } from "../_shared/ingest-file.ts";
import {
  createAirtableRecord,
  getAirtableRecord,
  patchAirtableRecord,
} from "../_shared/airtable.ts";
import {
  type AirtableEvidenceAttachment,
  parseAirtableEvidenceAttachments,
} from "../_shared/airtable-evidence.ts";
import { fetchWithRetry } from "../_shared/retry.ts";
import { enqueueAudit, kickAuditWorker } from "../_shared/audit-queue.ts";
import {
  type ExternalExtractionStatus,
  makeExternalStaleMs,
  summarizeExternalJobs,
} from "../_shared/external-extraction.ts";
import { evidenceProgressMessage, summarizeEvidenceProgress } from "./progress-logic.ts";

const FUNCTION_NAME = "sync-control-evidence";
const STORAGE_BUCKET = "evidence";
// TTL for the signed URLs we hand Airtable for the V3_Evidence attachments —
// Airtable fetches + caches the file within this window. 24h is plenty.
const SIGNED_URL_TTL_SECONDS = 86400;
// Airtable table IDs — stable across base clones.
const AIRTABLE_CONTROLS_TABLE_ID = "tblZrxDzOKd9FJkbC"; // Ecton Controls
const AIRTABLE_EVIDENCE_LOG_TABLE_ID = "tblJz6xg6RbK8Q21M"; // Evidence Log

type EvidenceSourceKind = "airtable_v3_evidence" | "google_drive";

interface SyncEvidenceFile extends DriveFile {
  source: EvidenceSourceKind;
  downloadUrl?: string;
}

// How many evidence files to ingest at once. Each file ≈ 30-45s (mostly waiting on
// Haiku extract + OpenAI embed), so doing them one-at-a-time pushed multi-file
// controls past the edge-function wall-clock limit — the worker was killed mid-run
// and the job sat stuck in "running". Running up to this many at once cuts the
// wall-clock to ≈ ceil(files / N) * per-file, while staying gentle on Claude/OpenAI
// rate limits. Override via env without a code change if it needs tuning.
const EVIDENCE_CONCURRENCY = Math.max(1, Number(Deno.env.get("EVIDENCE_CONCURRENCY") ?? "5"));

// "Heavy" files are processed ONE per invocation (the rest defer to the
// self-chain): in Batch Test 05, several vendor SOC 2 reports ingested
// simultaneously in one worker (each large PDF fanning out into ~11 parallel
// section calls) exhausted the isolate's memory and the platform killed it
// silently — four attempts in a row on the same folder (CC.09.04).
//
// Byte size alone is a BAD proxy (measured on that folder): a 100+ page text
// PDF is only ~2 MB, and a 0.5 MB xlsx is a zip that decompresses to many MB
// of CSV. So classification is type-aware:
//   - xlsx/xls: always heavy (decompression blowup is unpredictable)
//   - pdf: heavy at ≥ PDF_HEAVY_BYTES (~30+ pages) or when Drive omits the size
//   - anything else: heavy at ≥ GENERIC_HEAVY_BYTES
const PDF_HEAVY_BYTES = Math.max(
  100_000,
  Number(Deno.env.get("EVIDENCE_PDF_HEAVY_BYTES") ?? "1000000"),
);
const GENERIC_HEAVY_BYTES = Math.max(
  500_000,
  Number(Deno.env.get("EVIDENCE_HEAVY_FILE_BYTES") ?? "4000000"),
);

// Wall-clock budget for one invocation's ingest work. Once this elapses we stop
// launching new files (in-flight ones finish) and re-invoke this function to
// continue the rest — so a big control (20+ slow PDFs) that can't finish within
// the edge-function limit completes across several self-chained runs instead of
// getting killed mid-run. Kept well under the ~150s edge ceiling. Env-overridable.
const SYNC_BUDGET_MS = Math.max(20_000, Number(Deno.env.get("SYNC_BUDGET_MS") ?? "50000"));

// Hard ceiling on a SINGLE file's download → Storage upload → ingest. SYNC_BUDGET_MS
// only gates LAUNCHING new files; it does NOT bound a file already in flight. With this,
// a hung file is marked "failed" (reason surfaced) and the remaining files, the self-chain,
// and the audit all proceed instead of the control freezing mid-progress-bar.
// Raised 80s → 150s so genuinely SLOW-but-valid files finish and make the audit — a big
// 100+ page PDF (chunk + aggregate) legitimately needs ~2-2.5 min, and at 80s it was always
// timed out + skipped. A truly HUNG call is still caught earlier by the 60s per-call abort
// in claude-client / drive-client, so this longer ceiling only helps real slow work. Stays
// under the observed edge wall-clock headroom (ingest runs of ~170s have completed).
const PER_FILE_TIMEOUT_MS = Math.max(
  20_000,
  Number(Deno.env.get("SYNC_PER_FILE_TIMEOUT_MS") ?? "150000"),
);

const AIRTABLE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = Math.max(
  5_000,
  Number(Deno.env.get("AIRTABLE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS") ?? "25000"),
);

async function downloadAirtableAttachment(file: SyncEvidenceFile): Promise<Uint8Array> {
  if (!file.downloadUrl) throw new Error(`Airtable attachment '${file.name}' has no download URL`);

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AIRTABLE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(file.downloadUrl, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      console.warn(
        `V3_Evidence download '${file.name}' attempt ${attempt}/2 failed: ${
          (error as Error).message
        }`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `V3_Evidence download failed after 2 attempts: ${(lastError as Error)?.message}`,
  );
}

function airtableAttachmentToSyncFile(
  attachment: AirtableEvidenceAttachment,
  index: number,
): SyncEvidenceFile {
  return {
    id: attachment.id ?? `airtable-attachment-${index + 1}`,
    name: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    source: "airtable_v3_evidence",
    downloadUrl: attachment.url,
  };
}

// Maps internal FileType to the Airtable Evidence Log "File Type" singleSelect options.
function airtableFileType(fileType: string | undefined): string | undefined {
  if (!fileType) return undefined;
  if (fileType === "pdf_small" || fileType === "pdf_large") return "PDF";
  if (fileType === "csv") return "CSV";
  if (fileType === "image") return "PNG";
  if (fileType === "doc") return "Docx";
  return undefined;
}

// Best-effort 💬 status writer. sync-control-evidence OWNS this message: it does
// the Drive pull, so it announces it — and because it runs server-side, the
// status survives even if the Airtable per-control script hits its ~30s time cap
// while awaiting this call. Never throws (a status write must not fail the sync).
async function setStatus(
  baseId: string | null,
  recordId: string | null,
  msg: string,
): Promise<void> {
  await patchAirtableRecord({
    baseId,
    tableId: AIRTABLE_CONTROLS_TABLE_ID,
    recordId,
    fields: { "ClearCheck 💬": msg },
  }).catch(() => {});
}

// The subset of fields the Evidence Log row needs — built from the DB at the end
// of a sync (finalizeControlEvidence). IngestFileResult is structurally assignable.
interface EvidenceLogInput {
  status: "extracted" | "skipped" | "queued" | "failed";
  filename: string;
  file_type?: string;
  file_size_bytes?: number;
  extracted_summary?: string;
  scratchpad?: string | null;
  error?: string;
  skip_reason?: string;
  tokens?: { input: number; output: number };
}

// Best-effort Evidence Log row creator — one row per file.
// Maps the input fields to the Evidence Log table schema.
// Never throws — a failed write must not fail the overall sync.
async function createEvidenceLogRow(args: {
  baseId: string | null;
  controlRecordId: string | null;
  result: EvidenceLogInput;
}): Promise<void> {
  if (!args.baseId || !args.controlRecordId) return;

  // Map status to Airtable's Processing Status choices.
  const processingStatus = args.result.status === "failed" ? "Error" : "Complete";

  const fields: Record<string, unknown> = {
    Filename: args.result.filename,
    "Processing Status": processingStatus,
    // Link to the control record. Airtable's REST API wants an array of record-ID
    // STRINGS (["rec…"]), NOT [{id:"rec…"}] — the object form is rejected with
    // INVALID_RECORD_ID, which silently failed every Evidence Log write.
    Controls: [args.controlRecordId],
  };

  const ft = airtableFileType(args.result.file_type);
  if (ft) fields["File Type"] = ft;

  if (args.result.file_size_bytes != null) {
    fields["File_Size (MB)"] = (args.result.file_size_bytes / 1048576).toFixed(3);
  }
  // Full extracted_content JSON.
  if (args.result.extracted_summary) {
    fields["Extracted_Data"] = args.result.extracted_summary;
  }
  if (args.result.scratchpad) {
    fields["Scratchpad"] = args.result.scratchpad;
  }
  // Note field: show why a file was skipped or what failed.
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

// Lists the Filenames of Evidence Log rows already linked to this control, so we
// never create a duplicate row on a re-tick (or clobber rerun's additional-evidence
// rows). Airtable returns linked fields as record-ID arrays, so we filter client-side
// by the Controls link (filterByFormula can't match a linked record by id). Paginated,
// hard-capped. Best-effort — on any failure we return what we have (worst case: a dup).
async function listControlEvidenceLogFilenames(
  baseId: string,
  controlRecordId: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  const pat = Deno.env.get("AIRTABLE_PAT");
  if (!pat) return out;
  let offset: string | undefined;
  for (let page = 0; page < 50; page++) { // cap: 50 pages × 100 = 5000 rows
    const url = new URL(
      `https://api.airtable.com/v0/${baseId}/${AIRTABLE_EVIDENCE_LOG_TABLE_ID}`,
    );
    url.searchParams.set("pageSize", "100");
    url.searchParams.append("fields[]", "Filename");
    url.searchParams.append("fields[]", "Controls");
    if (offset) url.searchParams.set("offset", offset);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${pat}` } })
      .catch(() => null);
    if (!resp || !resp.ok) break;
    const data = await resp.json() as {
      records: { fields: { Filename?: string; Controls?: string[] } }[];
      offset?: string;
    };
    for (const rec of data.records) {
      if ((rec.fields.Controls ?? []).includes(controlRecordId) && rec.fields.Filename) {
        out.add(rec.fields.Filename);
      }
    }
    if (!data.offset) break;
    offset = data.offset;
  }
  return out;
}

// Completion step: ATTACH every evidence file to the control's V3_Evidence field
// FIRST, then write any missing Evidence Log rows. Reads the full set from the DB
// so it is correct no matter how many self-chained runs produced it. Best-effort —
// a failure here must never fail the sync (the evidence is already ingested).
async function finalizeControlEvidence(args: {
  engagementId: string;
  controlId: string;
  baseId: string | null;
  controlRecordId: string | null;
}): Promise<void> {
  if (!args.baseId || !args.controlRecordId) return;

  // 1. Load every distinct file linked to the control + its latest extraction.
  type FileRow = {
    filename: string;
    file_type: string;
    file_size_bytes: number | null;
    storage_path: string;
    status: string;
    error_message: string | null;
    extracted_content: Record<string, unknown> | null;
    scratchpad: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
  };
  const rows = await withEngagementScope(args.engagementId, async (tx) => {
    return await tx<FileRow[]>`
      select distinct on (ef.id)
        ef.filename,
        ef.file_type,
        ef.file_size_bytes,
        ef.storage_path,
        ef.status,
        ef.error_message,
        ee.extracted_content,
        ee.scratchpad,
        ee.input_tokens,
        ee.output_tokens
      from evidence_files ef
      join evidence_control_links l on l.evidence_file_id = ef.id
      left join extracted_evidence ee on ee.evidence_file_id = ef.id
      where l.control_id = ${args.controlId}
      order by ef.id, ee.extracted_at desc nulls last
    `;
  });
  if (rows.length === 0) return;

  // 2. ATTACH FIRST — sign each file's Storage object and PATCH the control's
  // V3_Evidence attachment field (+ the visible count). Best-effort per file.
  const supabase = getServiceClient();
  const signed: { url: string; filename: string }[] = [];
  for (const r of rows) {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(r.storage_path, SIGNED_URL_TTL_SECONDS);
    if (error || !data) {
      console.warn(`Failed to sign URL for ${r.filename}: ${error?.message ?? "no data"}`);
      continue;
    }
    signed.push({ url: data.signedUrl, filename: r.filename });
  }
  const attachFields: Record<string, unknown> = { V3_Evidence_Count: rows.length };
  // Omit V3_Evidence when empty — sending [] would CLEAR existing attachments.
  if (signed.length > 0) attachFields.V3_Evidence = signed;
  await patchAirtableRecord({
    baseId: args.baseId,
    tableId: AIRTABLE_CONTROLS_TABLE_ID,
    recordId: args.controlRecordId,
    fields: attachFields,
  }).catch(() => {});

  // 3. LOG SECOND — create Evidence Log rows only for files that don't have one
  // yet (dedupe by filename), so a re-tick never duplicates and rerun's rows survive.
  const existing = await listControlEvidenceLogFilenames(args.baseId, args.controlRecordId);
  for (const r of rows) {
    if (existing.has(r.filename)) continue;
    const result: EvidenceLogInput = {
      status: r.status === "failed" ? "failed" : "extracted",
      filename: r.filename,
      file_type: r.file_type,
      file_size_bytes: r.file_size_bytes ?? undefined,
      extracted_summary: r.extracted_content ? JSON.stringify(r.extracted_content) : undefined,
      scratchpad: r.scratchpad,
      tokens: r.input_tokens != null
        ? { input: r.input_tokens, output: r.output_tokens ?? 0 }
        : undefined,
      error: r.error_message ?? undefined,
    };
    await createEvidenceLogRow({
      baseId: args.baseId,
      controlRecordId: args.controlRecordId,
      result,
    });
  }
}

interface RequestPayload {
  control_uuid: string; // controls.id (UUID)
  trigger_source?: string;
  // Internal, set only by the self-chain: filenames that already FAILED during
  // this sync cycle. Chained runs skip them so the cycle converges — without
  // this, a failing file was re-attempted on EVERY chain link, and if the
  // failures consumed the whole time budget the chain made zero progress
  // forever (observed live 2026-07-21: three >4 MB corrupt PNGs looped
  // CC.06.25 indefinitely). A FRESH trigger (Airtable/manual) never sets this,
  // so pressing Re-run still retries everything (e.g. after replacing a file).
  chain_failed?: string[];
  // Internal, set only by the self-chain: how many links deep this cycle is.
  chain_depth?: number;
  // Durable orchestration id carried across self-chains and Make callbacks.
  sync_run_id?: string;
  // Callback-only auth mode. Make never receives AUDIT_SHARED_SECRET; the
  // secured callback uses it for this server-to-server resume invocation.
  internal_resume?: boolean;
  engagement_id?: string;
}

// Backstop against ANY future non-convergence: a sync cycle may self-chain at
// most this many times before it stops and tells the auditor. A legitimate
// giant control (60+ files at ~1 heavy/link) stays well under it.
const configuredMaxChainDepth = Number(Deno.env.get("SYNC_MAX_CHAIN_DEPTH") ?? "40");
const MAX_CHAIN_DEPTH = Number.isFinite(configuredMaxChainDepth)
  ? Math.max(5, configuredMaxChainDepth)
  : 40;

// Zip archives can't be text-extracted as-is — Drive hands them over compressed.
// We skip them with a clear "please unzip" message rather than failing cryptically.
function isZip(f: { name: string; mimeType: string }): boolean {
  const name = (f.name ?? "").toLowerCase();
  return (
    name.endsWith(".zip") ||
    f.mimeType === "application/zip" ||
    f.mimeType === "application/x-zip-compressed"
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type SyncRunStatus = "dispatching" | "waiting_external" | "resuming" | "completed" | "failed";

interface SyncRunRow {
  id: string;
  engagement_id: string;
  control_uuid: string;
  status: SyncRunStatus;
  updated_at: string;
}

// Start a durable sync cycle, or reuse its active row after a self-chain,
// callback resume, or accidental double-click.
async function ensureSyncRun(args: {
  engagementId: string;
  controlUuid: string;
  requestedId?: string;
}): Promise<SyncRunRow> {
  const supabase = getServiceClient();

  if (args.requestedId) {
    const { data, error } = await supabase
      .from("evidence_sync_runs")
      .select("id,engagement_id,control_uuid,status,updated_at")
      .eq("id", args.requestedId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load evidence sync run: ${error.message}`);
    if (!data) throw new Error(`Evidence sync run ${args.requestedId} was not found`);
    if (data.engagement_id !== args.engagementId || data.control_uuid !== args.controlUuid) {
      throw new Error("Evidence sync run does not belong to this control");
    }
    if (data.status === "completed" || data.status === "failed") {
      throw new Error(`Evidence sync run is already ${data.status}`);
    }
    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await supabase
      .from("evidence_sync_runs")
      .update({ status: "dispatching", updated_at: now, error_message: null })
      .eq("id", data.id)
      .select("id,engagement_id,control_uuid,status,updated_at")
      .single();
    if (updateError) throw new Error(`Failed to resume evidence sync run: ${updateError.message}`);
    return updated as SyncRunRow;
  }

  const { data: active, error: activeError } = await supabase
    .from("evidence_sync_runs")
    .select("id,engagement_id,control_uuid,status,updated_at")
    .eq("control_uuid", args.controlUuid)
    .in("status", ["dispatching", "waiting_external", "resuming"])
    .maybeSingle();
  if (activeError) throw new Error(`Failed to check active evidence sync: ${activeError.message}`);
  if (active) {
    const activeRun = active as unknown as SyncRunRow;
    const staleMs = makeExternalStaleMs();
    const isStaleExternalWait = activeRun.status === "waiting_external" &&
      Date.now() - Date.parse(activeRun.updated_at) >= staleMs;
    if (isStaleExternalWait) {
      const staleMessage = `External extraction did not complete within ${
        Math.round(staleMs / 60_000)
      } minutes; superseded by a new Run V3 request`;
      const now = new Date().toISOString();
      const { data: abandoned, error: abandonError } = await supabase
        .from("evidence_sync_runs")
        .update({
          status: "failed",
          error_message: staleMessage,
          completed_at: now,
          updated_at: now,
        })
        .eq("id", activeRun.id)
        .eq("status", "waiting_external")
        .eq("updated_at", activeRun.updated_at)
        .select("id")
        .maybeSingle();
      if (abandonError) {
        throw new Error(`Failed to abandon stale evidence sync: ${abandonError.message}`);
      }
      if (abandoned) {
        await supabase.from("external_extraction_jobs").update({
          status: "failed",
          error_message: staleMessage,
          completed_at: now,
          updated_at: now,
        }).eq("sync_run_id", activeRun.id).in("status", [
          "queued",
          "processing",
          "completing",
        ]);
        // The partial unique index no longer sees a live run, so continue below
        // and create a fresh cycle. Already-extracted files remain deduped.
      } else {
        // A callback changed the state while we were claiming the stale row.
        // Re-enter once and use its current active state.
        return await ensureSyncRun(args);
      }
    } else {
      const { error: updateError } = await supabase.from("evidence_sync_runs").update({
        status: "dispatching",
        updated_at: new Date().toISOString(),
      }).eq("id", activeRun.id);
      if (updateError) {
        throw new Error(`Failed to resume active evidence sync: ${updateError.message}`);
      }
      return { ...activeRun, status: "dispatching" };
    }
  }

  const id = crypto.randomUUID();
  const { data: created, error: createError } = await supabase
    .from("evidence_sync_runs")
    .insert({
      id,
      engagement_id: args.engagementId,
      control_uuid: args.controlUuid,
      status: "dispatching",
    })
    .select("id,engagement_id,control_uuid,status,updated_at")
    .single();
  if (!createError) return created as SyncRunRow;

  // Another invocation may have inserted the one-live-row between our read
  // and insert. Reuse it instead of failing or creating duplicate Make work.
  if (createError.code === "23505") {
    const { data: raced, error: racedError } = await supabase
      .from("evidence_sync_runs")
      .select("id,engagement_id,control_uuid,status,updated_at")
      .eq("control_uuid", args.controlUuid)
      .in("status", ["dispatching", "waiting_external", "resuming"])
      .single();
    if (!racedError && raced) return raced as SyncRunRow;
  }
  throw new Error(`Failed to create evidence sync run: ${createError.message}`);
}

async function updateSyncRun(
  id: string,
  patch: {
    status?: SyncRunStatus;
    total_files?: number;
    error_message?: string | null;
    completed_at?: string | null;
  },
): Promise<void> {
  const { error } = await getServiceClient()
    .from("evidence_sync_runs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`Failed to update evidence sync run: ${error.message}`);
}

async function loadExternalJobSummary(syncRunId: string) {
  const { data, error } = await getServiceClient()
    .from("external_extraction_jobs")
    .select("status,error_message")
    .eq("sync_run_id", syncRunId);
  if (error) throw new Error(`Failed to read external extraction jobs: ${error.message}`);
  return summarizeExternalJobs(
    (data ?? []) as { status: ExternalExtractionStatus; error_message: string | null }[],
  );
}

// Fire-and-forget call to a sibling edge function, forwarding the inbound
// per-engagement key. Used to (a) chain to run-audit once evidence is ready, and
// (b) self-chain — re-invoke THIS function to continue ingesting when a big control
// can't finish within one invocation's wall-clock budget. Best-effort: a failure is
// logged, not fatal — the 💬 + job_runs carry state.
async function triggerFunction(
  fnName: string,
  inboundKey: string | null,
  controlUuid: string,
  extraBody: Record<string, unknown> = {},
): Promise<boolean> {
  const base = Deno.env.get("SUPABASE_URL");
  if (!base || !inboundKey) {
    console.error(`triggerFunction(${fnName}): missing SUPABASE_URL or inbound key — skipping`);
    return false;
  }
  try {
    const res = await fetchWithRetry(`${base}/functions/v1/${fnName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-audit-secret": inboundKey },
      body: JSON.stringify({ control_uuid: controlUuid, ...extraBody }),
    }, { label: fnName });
    if (!res.ok) {
      console.error(`triggerFunction(${fnName}): HTTP ${res.status} after retries`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`triggerFunction(${fnName}) failed after retries: ${(e as Error).message}`);
    return false;
  }
}

Deno.serve(async (req: Request) => {
  const startTime = Date.now();

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
  const internalResume = payload.internal_resume === true;
  let engagementId: string;
  if (internalResume) {
    const authError = checkSharedSecret(req);
    if (authError) return authError;
    if (typeof payload.engagement_id !== "string" || !payload.engagement_id) {
      return jsonResponse({ error: "Internal resume requires 'engagement_id'" }, 400);
    }
    engagementId = payload.engagement_id;
  } else {
    // Normal callers use the per-engagement key, which resolves the tenant and
    // is then stamped into every scoped DB transaction.
    const authResult = await resolveEngagementByKey(req);
    if ("error" in authResult) return authResult.error;
    engagementId = authResult.engagementId;
  }
  // Captured for self-chain calls. In callback-resume mode this is the shared
  // secret; the child body retains internal_resume + engagement_id.
  const inboundKey = req.headers.get("x-audit-secret");
  const trigger_source = payload.trigger_source ?? "airtable";
  // Failed-file memory + depth counter for this sync cycle (see RequestPayload).
  const chainFailed = new Set<string>(
    Array.isArray(payload.chain_failed)
      ? payload.chain_failed.filter((n): n is string => typeof n === "string")
      : [],
  );
  const chainDepth = Number.isFinite(payload.chain_depth) ? Number(payload.chain_depth) : 0;

  // Load control + engagement drive folder in one scoped transaction. The
  // scoped role can only see this engagement's rows — a mismatched control_uuid
  // simply returns no rows (not found) rather than leaking another tenant's data.
  let control!: {
    id: string;
    engagement_id: string;
    control_id: string;
    airtable_record_id: string | null;
  };
  let evidenceFolderId: string | null = null;
  // For 💬 write-back: control's Airtable record + engagement's real base id.
  let airtableBase: string | null = null;
  try {
    const result = await withEngagementScope(engagementId, async (tx) => {
      const [ctrl] = await tx<
        {
          id: string;
          engagement_id: string;
          control_id: string;
          airtable_record_id: string | null;
        }[]
      >`
        select id, engagement_id, control_id, airtable_record_id
        from controls where id = ${payload.control_uuid}
      `;
      if (!ctrl) return null;
      const [eng] = await tx<
        { evidence_folder_id: string | null; airtable_base: string | null }[]
      >`
        select evidence_folder_id, airtable_base from engagements where id = ${ctrl.engagement_id}
      `;
      return {
        ctrl,
        evidenceFolderId: eng?.evidence_folder_id ?? null,
        airtableBase: eng?.airtable_base ?? null,
      };
    });
    if (!result) return jsonResponse({ error: `Control ${payload.control_uuid} not found` }, 404);
    // Defense-in-depth: RLS already prevents cross-engagement reads.
    if (result.ctrl.engagement_id !== engagementId) {
      return jsonResponse({ error: "Unauthorized" }, 403);
    }
    control = result.ctrl;
    evidenceFolderId = result.evidenceFolderId;
    airtableBase = result.airtableBase;
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }

  let syncRun: SyncRunRow;
  try {
    syncRun = await ensureSyncRun({
      engagementId: control.engagement_id,
      controlUuid: control.id,
      requestedId: payload.sync_run_id,
    });
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
  const slug = engagementSlug(control.engagement_id);
  // Service client kept only for Storage uploads — Storage is not RLS-gated the
  // same way and needs the service_role key for bucket access.
  const supabase = getServiceClient();

  let job;
  try {
    job = await startJobRun({
      function_name: FUNCTION_NAME,
      trigger_source,
      payload: {
        control_uuid: control.id,
        control_id: control.control_id,
        sync_run_id: syncRun.id,
        internal_resume: internalResume,
      },
      engagement_id: control.engagement_id,
    });
  } catch (err) {
    await updateSyncRun(syncRun.id, {
      status: "failed",
      error_message: `Failed to start job_run: ${(err as Error).message}`,
      completed_at: new Date().toISOString(),
    }).catch(() => {});
    return jsonResponse(
      { error: `Failed to start job_run: ${(err as Error).message}` },
      500,
    );
  }

  const results: IngestFileResult[] = [];

  // All the slow work (source pull + per-file ingest, ~1-2 min) runs as a background
  // task so we ack the Airtable caller fast (well under its ~30s script cap) and then
  // chain to run-audit ourselves. Mirrors run-audit's own background pattern.
  const processSync = async (): Promise<Response> => {
    // Announce source selection first. A non-empty V3_Evidence field takes
    // precedence; Google Drive remains the fallback when the field is empty.
    await setStatus(
      airtableBase,
      control.airtable_record_id,
      "🔎 Checking V3_Evidence for uploaded files…",
    );

    try {
      // 1. Read V3_Evidence from the Airtable control record. If it contains
      // attachments, those files are the complete source for this sync and Drive
      // is not listed or downloaded. Missing Airtable metadata keeps the legacy
      // Drive-only path available for non-Airtable callers.
      const airtableRecord = await getAirtableRecord({
        baseId: airtableBase,
        tableId: AIRTABLE_CONTROLS_TABLE_ID,
        recordId: control.airtable_record_id,
        fields: ["V3_Evidence"],
      });
      if (!airtableRecord.ok) {
        throw new Error(
          `Could not check Airtable V3_Evidence before selecting an evidence source: ` +
            `${airtableRecord.error ?? "unknown Airtable error"}`,
        );
      }
      const v3EvidenceRaw: unknown = airtableRecord.record?.fields.V3_Evidence;
      const airtableAttachments = parseAirtableEvidenceAttachments(v3EvidenceRaw);
      const v3EvidenceIsNonEmpty = Array.isArray(v3EvidenceRaw)
        ? v3EvidenceRaw.length > 0
        : v3EvidenceRaw != null;
      if (v3EvidenceIsNonEmpty && airtableAttachments.length === 0) {
        throw new Error(
          "V3_Evidence is not empty, but it does not contain any valid Airtable attachments",
        );
      }

      let token: string | null = null;
      let sourceKind: EvidenceSourceKind;
      let sourceName: string;
      let files: SyncEvidenceFile[];

      if (airtableAttachments.length > 0) {
        sourceKind = "airtable_v3_evidence";
        sourceName = "V3_Evidence";
        files = airtableAttachments.map(airtableAttachmentToSyncFile);
        await setStatus(
          airtableBase,
          control.airtable_record_id,
          `📎 Reading ${files.length} file${files.length === 1 ? "" : "s"} from V3_Evidence…`,
        );
      } else {
        if (!evidenceFolderId) {
          throw new Error(
            `V3_Evidence is empty and engagement ${control.engagement_id} has no ` +
              `evidence_folder_id. Upload evidence to V3_Evidence or run register-engagement first.`,
          );
        }

        await setStatus(
          airtableBase,
          control.airtable_record_id,
          "🔎 V3_Evidence is empty — pulling evidence from Google Drive…",
        );

        // 2. Google Drive fallback: authenticate and find the control subfolder
        // by name prefix (before the first "-").
        token = await getDriveAccessToken();
        const subfolders = await driveList(
          token,
          `'${evidenceFolderId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
        );
        const match = subfolders.find((f) => f.name.split("-")[0].trim() === control.control_id);
        if (!match) {
          // Friendly user-facing 💬 — short and actionable. The full list of folders
          // we DID find stays in the job log (failJobRun) for debugging, not in the 💬.
          await setStatus(
            airtableBase,
            control.airtable_record_id,
            `📁 No evidence found for ${control.control_id} — upload files to V3_Evidence ` +
              `or the control's Google Drive folder, then re-run.`,
          );
          await failJobRun({
            handle: job,
            error_message: `No Drive subfolder for ${control.control_id}. ` +
              `Available: ${subfolders.map((f) => f.name).join(", ") || "(none)"}`,
          });
          await updateSyncRun(syncRun.id, {
            status: "failed",
            error_message: `No Drive subfolder for ${control.control_id}`,
            completed_at: new Date().toISOString(),
          });
          return jsonResponse({
            error: `No evidence found in V3_Evidence or Google Drive for ${control.control_id}.`,
            control_uuid: control.id,
            total_files: 0,
            summary: { processed: 0, skipped: 0, failed: 0 },
            job_run_id: job.id,
          }, 422);
        }

        sourceKind = "google_drive";
        sourceName = match.name;
        files = (await driveList(token, `'${match.id}' in parents and trashed = false`))
          .filter((f) => f.mimeType !== FOLDER_MIME)
          .map((f) => ({ ...f, source: "google_drive" as const }));
      }

      const sourceResult = {
        evidence_source: sourceKind,
        source_name: sourceName,
        ...(sourceKind === "google_drive" ? { subfolder: sourceName } : {}),
      };

      await updateSyncRun(syncRun.id, { total_files: files.length });

      if (files.length === 0) {
        await setStatus(
          airtableBase,
          control.airtable_record_id,
          `📭 Evidence folder "${sourceName}" is empty — upload files to V3_Evidence or ` +
            `Google Drive and re-run.`,
        );
        await failJobRun({
          handle: job,
          error_message: `Evidence source "${sourceName}" is empty`,
        });
        await updateSyncRun(syncRun.id, {
          status: "failed",
          error_message: `Evidence source "${sourceName}" is empty`,
          completed_at: new Date().toISOString(),
        });
        return jsonResponse({
          error: `Evidence source "${sourceName}" is empty — add files and re-run.`,
          control_uuid: control.id,
          total_files: 0,
          summary: { processed: 0, skipped: 0, failed: 0 },
          job_run_id: job.id,
        }, 422);
      }

      // 3b. Skip files already ingested for THIS control (prior run / earlier chain),
      //     so we don't re-download them. This makes self-chaining converge: each run
      //     only touches the files still pending.
      const doneNames = await withEngagementScope(control.engagement_id, async (tx) => {
        const rows = await tx<{ filename: string }[]>`
        select distinct ef.filename
        from evidence_control_links l
        join evidence_files ef on ef.id = l.evidence_file_id
        join extracted_evidence ee on ee.evidence_file_id = ef.id
        where l.control_id = ${control.id}
      `;
        return new Set(rows.map((r) => r.filename));
      });
      // Light files first, heavyweights last: quick wins land early, and the
      // heavy tail defers cleanly to the self-chain (see PDF_HEAVY_BYTES).
      const isHeavyFile = (f: DriveFile) => {
        const ext = f.name.toLowerCase().split(".").pop() ?? "";
        if (ext === "xlsx" || ext === "xls") return true;
        if (ext === "pdf") return f.size === undefined || f.size >= PDF_HEAVY_BYTES;
        return (f.size ?? 0) >= GENERIC_HEAVY_BYTES;
      };
      const pending = files
        .filter((f) => !doneNames.has(f.name))
        // Skip files that already failed earlier in THIS chain cycle — retrying
        // them every link burned the whole budget and made the chain loop forever.
        .filter((f) => !chainFailed.has(f.name))
        .sort((a, b) => Number(isHeavyFile(a)) - Number(isHeavyFile(b)));

      // Progress bar (Option B — server-rendered into 💬). Counts are CUMULATIVE across
      // self-chained runs: total = every file in the folder, done = already-ingested
      // (prior runs/chains) + completed this run — so the bar keeps advancing run to run.
      const totalFiles = files.length;
      const doneBefore = files.filter((file) => doneNames.has(file.name)).length;
      let lastBarShown = -1; // monotonic guard so out-of-order PATCHes can't go backward
      await setStatus(
        airtableBase,
        control.airtable_record_id,
        evidenceProgressMessage(
          { handled: doneBefore, ready: doneBefore, queuedExternal: 0, failed: 0 },
          totalFiles,
        ),
      );

      // 4. Process PENDING files concurrently, within a wall-clock budget. Each file:
      //    download → Storage → ingest. Up to EVIDENCE_CONCURRENCY at once; once
      //    SYNC_BUDGET_MS elapses we stop launching new ones (in-flight finish) and the
      //    rest are "deferred" → we re-invoke this function to continue (self-chaining),
      //    so a big control completes across runs instead of being killed mid-run.
      //    Zip archives are surfaced separately so the user gets an "unzip" nudge.
      const zipFiles: string[] = [];

      const processOneFile = async (f: SyncEvidenceFile): Promise<IngestFileResult> => {
        const fileStart = Date.now();
        const storagePath = `${slug}/${control.control_id}/${f.name}`;

        if (isZip(f)) {
          zipFiles.push(f.name);
          return {
            status: "skipped",
            filename: f.name,
            evidence_file_id: null,
            job_run_id: null,
            duration_ms: Date.now() - fileStart,
            error: `Zip archive — unzip the contents in ${sourceName} and re-upload.`,
          };
        }

        let fileBytes: Uint8Array;
        try {
          fileBytes = f.source === "airtable_v3_evidence"
            ? await downloadAirtableAttachment(f)
            : await driveDownload(token!, f.id);
        } catch (err) {
          return {
            status: "failed",
            filename: f.name,
            evidence_file_id: null,
            job_run_id: null,
            duration_ms: Date.now() - fileStart,
            error: `${sourceName} download failed: ${(err as Error).message}`,
          };
        }

        // Land the raw file in Storage (where run-audit later signs URLs from).
        // Uint8Array is accepted directly (see scripts/upload-fixtures.ts).
        const { error: upErr } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(storagePath, fileBytes, { upsert: true, contentType: f.mimeType });
        if (upErr) {
          return {
            status: "failed",
            filename: f.name,
            evidence_file_id: null,
            job_run_id: null,
            duration_ms: Date.now() - fileStart,
            error: `Storage upload failed: ${upErr.message}`,
          };
        }

        // Large Airtable PDFs have no Google Drive ID for Make. Give Make a
        // 24-hour URL for the private Storage copy we just wrote. The service
        // credential is never exposed; only this one object is readable.
        let externalDownloadUrl: string | undefined;
        if (f.source === "airtable_v3_evidence") {
          const { data: signedData, error: signedError } = await supabase.storage
            .from(STORAGE_BUCKET)
            .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
          if (signedError || !signedData) {
            console.warn(
              `Failed to create Make download URL for ${f.name}: ${
                signedError?.message ?? "no data"
              }; using the Airtable attachment URL`,
            );
          }
          externalDownloadUrl = signedData?.signedUrl ?? f.downloadUrl;
        }

        // Ingest the same bytes we already downloaded (no re-download).
        const r = await ingestFile({
          engagement_id: control.engagement_id,
          control_id: control.id,
          file_path: storagePath,
          filename: f.name,
          file_bytes: fileBytes,
          google_drive_file_id: f.source === "google_drive" ? f.id : undefined,
          external_download_url: externalDownloadUrl,
          trigger_source,
          sync_run_id: syncRun.id,
        });

        // NOTE: the Evidence Log row is NOT written here. We defer it to the end
        // (finalizeControlEvidence) so the files are ATTACHED to the control first,
        // and so logging works correctly across self-chained runs (each run ingests
        // a different batch; the final run logs the whole set from the DB).
        return r;
      };

      // Wrap one file in a hard timeout so a hung download/extraction can't deadlock its
      // worker (which would stop Promise.all from resolving, so the self-chain + audit
      // never run and the control freezes mid-bar). On timeout the file resolves as
      // "failed" with a surfaced reason and the pool moves on. The underlying call may
      // linger in the background until the isolate exits — acceptable; the result is
      // already settled. The timer is always cleared so a fast file leaves nothing armed.
      const processWithTimeout = async (f: SyncEvidenceFile): Promise<IngestFileResult> => {
        const fileStart = Date.now();
        let timer: number | undefined;
        const timeout = new Promise<IngestFileResult>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                status: "failed",
                filename: f.name,
                evidence_file_id: null,
                job_run_id: null,
                duration_ms: Date.now() - fileStart,
                error:
                  `File processing timed out after ${
                    Math.round(PER_FILE_TIMEOUT_MS / 1000)
                  }s (download/extraction did not return). The file may be too large or ` +
                  `the extractor stalled — check the file in ${sourceName} and re-run.`,
              }),
            PER_FILE_TIMEOUT_MS,
          );
        });
        try {
          return await Promise.race([processOneFile(f), timeout]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };

      // Budget-aware concurrent pool: up to EVIDENCE_CONCURRENCY workers pull from the
      // pending list until it's empty OR the time budget is hit (then they stop pulling
      // new files; in-flight ones still finish). Files never started are "deferred".
      // As each file finishes, advance the 💬 progress bar (cumulative across chained
      // runs; the monotonic guard avoids it jumping backward on out-of-order PATCHes).
      // Heavy-file governor: at most ONE heavy file in flight per invocation.
      // A worker that reaches a heavy file while another heavy is processing
      // simply STOPS pulling (the list is sorted lights-first, so everything from
      // that point on is heavy) — those files stay pending and the self-chain
      // continues them in the next invocation, one heavy at a time. This bounds
      // peak memory AND respects the wall-clock budget (a lock-queue would let
      // waiters process past the budget and get the isolate killed — the exact
      // failure this exists to prevent). The busy-check/set pair below has no
      // await between them, so it's race-free in a single-threaded isolate.
      let heavyBusy = false;
      let nextIdx = 0;
      const worker = async (): Promise<void> => {
        while (nextIdx < pending.length) {
          if (Date.now() - startTime > SYNC_BUDGET_MS) return; // out of budget — defer the rest
          const f = pending[nextIdx];
          const heavy = isHeavyFile(f);
          if (heavy && heavyBusy) return; // one heavy at a time — defer the rest to the chain
          nextIdx++;
          if (heavy) heavyBusy = true;
          try {
            results.push(await processWithTimeout(f));
          } finally {
            if (heavy) heavyBusy = false;
          }
          const progress = summarizeEvidenceProgress(doneBefore, results);
          if (progress.handled > lastBarShown) {
            lastBarShown = progress.handled;
            await setStatus(
              airtableBase,
              control.airtable_record_id,
              evidenceProgressMessage(progress, totalFiles),
            );
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(EVIDENCE_CONCURRENCY, pending.length) }, () => worker()),
      );
      const deferred = pending.length - results.length; // pending files not started this run

      // 5. Summarize (same shape as ingest-evidence-batch).
      let processed = 0;
      let skipped = 0;
      let queued = 0;
      let failed = 0;
      // Files skipped because they were ALREADY ingested (dedupe) — these still
      // count as usable evidence. Zip skips have no skip_reason, so they don't.
      let alreadyIngested = 0;
      let totalInput = 0;
      let totalOutput = 0;
      let totalEmbedding = 0;
      for (const r of results) {
        if (r.status === "extracted") processed++;
        else if (r.status === "skipped") {
          skipped++;
          if (r.skip_reason) alreadyIngested++; // file_dedupe / extraction_dedupe
        } else if (r.status === "queued") queued++;
        else failed++;
        if (r.tokens) {
          totalInput += r.tokens.input;
          totalOutput += r.tokens.output;
          totalEmbedding += r.tokens.embedding;
        }
      }

      // Read the actual linked+extracted count. This includes Make callbacks that
      // may have completed while local files were processing and avoids counting
      // a queued external file as audit-ready too early.
      const countReadyEvidence = () =>
        withEngagementScope(control.engagement_id, async (tx) => {
          const rows = await tx<{ n: number }[]>`
        select count(distinct ef.id)::int as n
        from evidence_files ef
        join evidence_control_links l on l.evidence_file_id = ef.id
        join extracted_evidence ee on ee.evidence_file_id = ef.id
        where l.control_id = ${control.id}
      `;
          return rows[0].n;
        });
      let totalReady = await countReadyEvidence();
      const summary = {
        processed,
        skipped,
        queued_external: queued,
        failed,
        already_ingested: alreadyIngested,
        deferred,
        total_ready: totalReady,
        total_files: files.length,
      };
      const tokens = { input: totalInput, output: totalOutput, embedding: totalEmbedding };
      const duration_ms = Date.now() - startTime;
      const plural = (n: number) => (n === 1 ? "" : "s");

      // If files were deferred (we hit the time budget), SELF-CHAIN: re-invoke this
      // function to process the rest, and do NOT trigger run-audit yet. The chain
      // carries forward both the done-set (via the DB pre-filter) and the FAILED
      // set (via chain_failed) so every link makes real progress on new files.
      if (deferred > 0 && chainDepth >= MAX_CHAIN_DEPTH) {
        // Backstop: something is preventing convergence — stop chaining and say so
        // instead of looping (and billing) forever.
        const depthMsg =
          `⚠️ Evidence sync stopped after ${chainDepth} passes with ${deferred} file(s) ` +
          `unfinished — press Re-run Audit to continue, or check the folder's files.`;
        await setStatus(airtableBase, control.airtable_record_id, depthMsg);
        await failJobRun({
          handle: job,
          error_message: `Chain depth cap hit (${chainDepth} >= ${MAX_CHAIN_DEPTH}), ` +
            `${deferred} deferred, ${chainFailed.size} carried failures`,
        });
        await updateSyncRun(syncRun.id, {
          status: "failed",
          error_message: depthMsg,
          completed_at: new Date().toISOString(),
        });
        return jsonResponse({ error: depthMsg, job_run_id: job.id }, 508);
      }
      if (deferred > 0) {
        await setStatus(
          airtableBase,
          control.airtable_record_id,
          `🔎 Pulling evidence… ${totalReady}/${files.length} done, continuing…`,
        );
        await completeJobRun({
          handle: job,
          result: {
            control_id: control.control_id,
            ...sourceResult,
            summary,
            tokens,
            duration_ms,
            self_chained: true,
            chain_depth: chainDepth,
          },
        });
        const failedThisRun = results
          .filter((r) => r.status === "failed" && r.filename)
          .map((r) => r.filename as string);
        const chained = await triggerFunction("sync-control-evidence", inboundKey, control.id, {
          chain_failed: [...chainFailed, ...failedThisRun],
          chain_depth: chainDepth + 1,
          sync_run_id: syncRun.id,
          ...(internalResume
            ? { internal_resume: true, engagement_id: control.engagement_id }
            : {}),
        });
        if (!chained) {
          // The continuation never launched — without this flag the 💬 would say
          // "continuing…" forever while nothing runs (the silent-stall failure mode).
          await setStatus(
            airtableBase,
            control.airtable_record_id,
            `⚠️ Evidence sync paused at ${totalReady}/${files.length} files — ` +
              `could not continue automatically. Press Re-run Audit to resume (already-read files are skipped).`,
          );
          await updateSyncRun(syncRun.id, {
            status: "failed",
            error_message: "Self-chain invocation failed",
            completed_at: new Date().toISOString(),
          });
        }
        return jsonResponse({
          accepted: true,
          status: "processing",
          control_uuid: control.id,
          sync_run_id: syncRun.id,
          ...sourceResult,
          total_files: files.length,
          summary,
          note: "More files pending; sync re-invoked itself to continue.",
          job_run_id: job.id,
        }, 202);
      }

      // Local dispatch is complete. If one or more large PDFs are with Make, stop
      // here without auditing a partial evidence set. The callback stores the
      // extraction and re-invokes this sync only after every external job in this
      // cycle has completed.
      let external = await loadExternalJobSummary(syncRun.id);
      const failForExternalJob = async (): Promise<Response> => {
        const details = external.errors.join(" | ") || "Make reported an extraction failure";
        const message = `❌ Large-PDF extraction failed (${external.failed} file${
          external.failed === 1 ? "" : "s"
        }). ${details}`;
        await setStatus(airtableBase, control.airtable_record_id, message);
        await failJobRun({ handle: job, error_message: message });
        await updateSyncRun(syncRun.id, {
          status: "failed",
          error_message: details,
          completed_at: new Date().toISOString(),
        });
        return jsonResponse({
          error: message,
          control_uuid: control.id,
          sync_run_id: syncRun.id,
          external,
          summary,
          job_run_id: job.id,
        }, 502);
      };

      if (external.state === "failed") return await failForExternalJob();
      if (external.state === "waiting") {
        await updateSyncRun(syncRun.id, { status: "waiting_external" });

        // Close the dispatch→waiting race: Make may have completed and checked
        // the run while it still said dispatching. Re-read after publishing the
        // waiting state; if nothing is pending, this invocation can continue.
        external = await loadExternalJobSummary(syncRun.id);
        if (external.state === "failed") return await failForExternalJob();
        if (external.state === "waiting") {
          const waitMessage = `☁️ Make is reading ${external.waiting} large PDF${
            external.waiting === 1 ? "" : "s"
          }… ${totalReady}/${files.length} files ready.`;
          await setStatus(airtableBase, control.airtable_record_id, waitMessage);
          await completeJobRun({
            handle: job,
            result: {
              control_id: control.control_id,
              sync_run_id: syncRun.id,
              status: "waiting_external",
              external,
              summary,
              tokens,
              duration_ms,
            },
          });
          return jsonResponse({
            accepted: true,
            status: "waiting_external",
            control_uuid: control.id,
            sync_run_id: syncRun.id,
            external,
            summary,
            job_run_id: job.id,
          }, 202);
        }
      }

      // A fast callback can complete during this same invocation. Refresh the
      // evidence count before the empty/partial checks and before audit enqueue.
      if (external.state === "ready") {
        totalReady = await countReadyEvidence();
        summary.total_ready = totalReady;
      }

      // Aggregate the DISTINCT per-file failure reasons (with counts) so both the
      // 💬 and the job_runs row say WHY files failed — not just "N files failed".
      // Without this the reason lived only in the function logs.
      const reasonCounts = new Map<string, number>();
      for (const r of results) {
        if (r.status === "failed" && r.error) {
          const key = r.error.length > 140 ? `${r.error.slice(0, 140)}…` : r.error;
          reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
        }
      }
      let failureReasons = Array.from(reasonCounts.entries())
        .map(([reason, n]) => (n > 1 ? `${reason} (×${n})` : reason))
        .join(" | ");
      // Failures carried from earlier links of this chain cycle (their reasons were
      // reported on those runs; here we surface the names so the count adds up).
      if (chainFailed.size > 0) {
        const carried = `${chainFailed.size} failed in earlier passes: ${
          [...chainFailed].join(", ")
        }`;
        failureReasons = failureReasons ? `${failureReasons} | ${carried}` : carried;
        failed += chainFailed.size;
      }

      // All pending files attempted this run — build the final status.
      let statusMsg: string;
      if (totalReady > 0) {
        statusMsg = `✅ Evidence ready (${totalReady} file${plural(totalReady)}).`;
        if (failed > 0) statusMsg += ` ⚠️ ${failed} file${plural(failed)} failed.`;
        if (zipFiles.length > 0) {
          statusMsg += ` ⚠️ Skipped ${zipFiles.length} zip file${plural(zipFiles.length)} ` +
            `— please unzip & re-upload: ${zipFiles.join(", ")}.`;
        }
      } else if (zipFiles.length > 0) {
        statusMsg = `📦 Only zip file${plural(zipFiles.length)} found ` +
          `(${zipFiles.join(", ")}). Please unzip the evidence in ${sourceName} and re-run.`;
      } else if (failed > 0) {
        statusMsg =
          `❌ Evidence could not be processed (${failed} file${plural(failed)} failed). ` +
          (failureReasons
            ? `Reason: ${failureReasons}`
            : `Check the files in ${sourceName} and re-run.`);
      } else {
        statusMsg = `📭 No evidence files found.`;
      }
      await setStatus(airtableBase, control.airtable_record_id, statusMsg);

      // Nothing usable (only zips / all failed) — halt 422 so run-audit doesn't run empty.
      if (totalReady === 0) {
        const noEvidenceError = zipFiles.length > 0
          ? `No usable evidence — only zip file(s): ${zipFiles.join(", ")}`
          : `No usable evidence — ${failed} file(s) failed. Reasons: ${
            failureReasons || "(none captured)"
          }`;
        await failJobRun({
          handle: job,
          error_message: noEvidenceError,
        });
        await updateSyncRun(syncRun.id, {
          status: "failed",
          error_message: noEvidenceError,
          completed_at: new Date().toISOString(),
        });
        return jsonResponse({
          error: statusMsg,
          control_uuid: control.id,
          ...sourceResult,
          total_files: files.length,
          summary,
          files: results,
          job_run_id: job.id,
        }, 422);
      }

      await completeJobRun({
        handle: job,
        result: {
          control_id: control.control_id,
          ...sourceResult,
          total_files: files.length,
          summary,
          tokens,
          duration_ms,
        },
      });

      // Settle wait: poll the control's linked+extracted evidence count until it stops
      // changing, so run-audit (a separate invocation/query) sees the FULL set. Without
      // this, run-audit can fire microseconds before the last files' rows are visible and
      // audit a subset (e.g. 17 of 20), undercounting V3_Evidence + attachments.
      let prevCount = -1;
      for (let i = 0; i < 8; i++) {
        const cnt = await withEngagementScope(control.engagement_id, async (tx) => {
          const r = await tx<{ n: number }[]>`
          select count(distinct ef.id)::int as n
          from evidence_files ef
          join evidence_control_links l on l.evidence_file_id = ef.id
          join extracted_evidence ee on ee.evidence_file_id = ef.id
          where l.control_id = ${control.id}
        `;
          return r[0].n;
        });
        if (cnt === prevCount) break; // stabilized — safe to audit
        prevCount = cnt;
        await new Promise((r) => setTimeout(r, 1500));
      }

      // Enqueue the audit FIRST, before the slow Airtable mirroring below (ADR-015).
      // The audit reads extracted evidence from the DB (settled above), not from the
      // Airtable attachments — and this worker is nearest its wall-clock kill at the
      // end of a big ingest, so the hand-off must leave the danger zone first.
      // Previously the hand-off was a fire-and-forget POST to run-audit: a worker
      // killed during the mirroring (or one dropped HTTP call) silently lost the
      // audit — the control sat at "✅ Evidence ready" forever with no error (Batch
      // Test 04/05, ~3 of 110 controls). Now the hand-off is a DURABLE queue row:
      // once written it survives a killed worker (the audit-worker cron claims it),
      // so even a kill during finalizeControlEvidence below cannot lose the audit.
      // The kick just lowers latency; a definitive ENQUEUE failure flags the 💬.
      const enq = await enqueueAudit(control.engagement_id, control.id);
      if (enq.queued) {
        await kickAuditWorker();
      } else {
        console.error(`enqueueAudit failed for ${control.control_id}: ${enq.error}`);
        await setStatus(
          airtableBase,
          control.airtable_record_id,
          `⚠️ Evidence ready (${totalReady} file${
            plural(totalReady)
          }) but the audit could not be ` +
            `queued — press Re-run Audit to launch it. (${enq.error})`,
        );
      }

      // ATTACH the evidence files to the control, then write the Evidence Log
      // rows. Both happen here (not per-file during ingest) so attachments land
      // before the log, and so the whole set is mirrored correctly even when the
      // ingest spanned several self-chained runs.
      await finalizeControlEvidence({
        engagementId: control.engagement_id,
        controlId: control.id,
        baseId: airtableBase,
        controlRecordId: control.airtable_record_id,
      });

      await updateSyncRun(syncRun.id, {
        status: "completed",
        error_message: null,
        completed_at: new Date().toISOString(),
      });

      return jsonResponse({
        success: true,
        control_uuid: control.id,
        ...sourceResult,
        total_files: files.length,
        sync_run_id: syncRun.id,
        summary,
        tokens,
        duration_ms,
        files: results,
        job_run_id: job.id,
      });
    } catch (err) {
      const e = err as Error;
      await setStatus(
        airtableBase,
        control.airtable_record_id,
        `❌ Evidence sync failed: ${e.message}`,
      );
      await failJobRun({ handle: job, error_message: e.message, error_stack: e.stack });
      await updateSyncRun(syncRun.id, {
        status: "failed",
        error_message: e.message,
        completed_at: new Date().toISOString(),
      }).catch((updateError) =>
        console.error(`Failed to mark evidence sync run failed: ${(updateError as Error).message}`)
      );
      return jsonResponse(
        { error: e.message, job_run_id: job.id, partial_results: results },
        500,
      );
    }
  };

  // Dispatch: in prod (Edge runtime) run the ingest in the background and ack
  // immediately so the Airtable script returns under its ~30s cap; the sync writes
  // its own 💬 + Evidence Log and then triggers run-audit when done. Locally (no
  // EdgeRuntime) await inline so tests/hand calls keep the synchronous contract.
  const edgeRuntime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(processSync().catch((e) => console.error(`processSync crashed: ${e}`)));
    return jsonResponse(
      {
        accepted: true,
        status: "processing",
        control_uuid: control.id,
        engagement_id: control.engagement_id,
        sync_run_id: syncRun.id,
        job_run_id: job.id,
        note: "Evidence sync runs in the background; run-audit is triggered when it completes.",
      },
      202,
    );
  }
  return await processSync();
});
