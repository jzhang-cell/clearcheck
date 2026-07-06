// sync-control-evidence — for ONE control: find its Google Drive subfolder,
// download each file, upload to Supabase Storage, and ingest it (extract +
// embed + store) via the shared ingestFile(). Called per control by the
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
import { startJobRun, completeJobRun, failJobRun } from "../_shared/job-run.ts";
import { resolveEngagementByKey } from "../_shared/auth.ts";
import { engagementSlug } from "../_shared/engagement-slug.ts";
import { type DriveFile, driveDownload, driveList, FOLDER_MIME, getDriveAccessToken } from "../_shared/drive-client.ts";
import { ingestFile } from "../_shared/ingest-file.ts";
import type { IngestFileResult } from "../_shared/ingest-file.ts";
import { patchAirtableRecord, createAirtableRecord } from "../_shared/airtable.ts";

const FUNCTION_NAME = "sync-control-evidence";
const STORAGE_BUCKET = "evidence";
// TTL for the signed URLs we hand Airtable for the V3_Evidence attachments —
// Airtable fetches + caches the file within this window. 24h is plenty.
const SIGNED_URL_TTL_SECONDS = 86400;
// Airtable table IDs — stable across base clones.
const AIRTABLE_CONTROLS_TABLE_ID = "tblZrxDzOKd9FJkbC";   // Ecton Controls
const AIRTABLE_EVIDENCE_LOG_TABLE_ID = "tblJz6xg6RbK8Q21M"; // Evidence Log

// How many evidence files to ingest at once. Each file ≈ 30-45s (mostly waiting on
// Haiku extract + OpenAI embed), so doing them one-at-a-time pushed multi-file
// controls past the edge-function wall-clock limit — the worker was killed mid-run
// and the job sat stuck in "running". Running up to this many at once cuts the
// wall-clock to ≈ ceil(files / N) * per-file, while staying gentle on Claude/OpenAI
// rate limits. Override via env without a code change if it needs tuning.
const EVIDENCE_CONCURRENCY = Math.max(1, Number(Deno.env.get("EVIDENCE_CONCURRENCY") ?? "5"));

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

// Renders a friendly stage line + a 10-segment emoji progress bar for ClearCheck 💬,
// e.g. "📄 Reading your evidence… 🟩🟩🟩⬜⬜⬜⬜⬜⬜⬜  3 of 9 files". Option B: 💬 is a
// plain text field this function writes, so the whole line is a server-rendered
// string we PATCH (not an Airtable formula). 🟩 renders green in Airtable.
const PROGRESS_SEGMENTS = 10;
function progressBar(done: number, total: number): string {
  const filled = total > 0
    ? Math.min(PROGRESS_SEGMENTS, Math.round((done / total) * PROGRESS_SEGMENTS))
    : 0;
  const bar = "🟩".repeat(filled) + "⬜".repeat(PROGRESS_SEGMENTS - filled);
  // Friendly, plain-English stage label so the user knows WHAT is happening, not
  // just a raw count. Reading = downloading each file from Drive + having Claude
  // extract its evidence.
  const label = done >= total && total > 0
    ? "✅ Evidence read — starting the audit…"
    : "📄 Reading your evidence…";
  return `${label} ${bar}  ${done} of ${total} files`;
}

// The subset of fields the Evidence Log row needs — built from the DB at the end
// of a sync (finalizeControlEvidence). IngestFileResult is structurally assignable.
interface EvidenceLogInput {
  status: "extracted" | "skipped" | "failed";
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
  const processingStatus =
    args.result.status === "failed" ? "Error" : "Complete";

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
}

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

// Fire-and-forget call to a sibling edge function, forwarding the inbound
// per-engagement key. Used to (a) chain to run-audit once evidence is ready, and
// (b) self-chain — re-invoke THIS function to continue ingesting when a big control
// can't finish within one invocation's wall-clock budget. Best-effort: a failure is
// logged, not fatal — the 💬 + job_runs carry state.
async function triggerFunction(
  fnName: string,
  inboundKey: string | null,
  controlUuid: string,
): Promise<void> {
  const base = Deno.env.get("SUPABASE_URL");
  if (!base || !inboundKey) {
    console.error(`triggerFunction(${fnName}): missing SUPABASE_URL or inbound key — skipping`);
    return;
  }
  try {
    const res = await fetch(`${base}/functions/v1/${fnName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-audit-secret": inboundKey },
      body: JSON.stringify({ control_uuid: controlUuid }),
    });
    if (!res.ok) console.error(`triggerFunction(${fnName}): HTTP ${res.status}`);
  } catch (e) {
    console.error(`triggerFunction(${fnName}) failed: ${(e as Error).message}`);
  }
}

Deno.serve(async (req: Request) => {
  // Per-engagement key auth — resolves which engagement this caller owns.
  const authResult = await resolveEngagementByKey(req);
  if ("error" in authResult) return authResult.error;
  const { engagementId } = authResult;
  // Capture the inbound per-engagement key now (req is valid here) so the
  // background task can forward it to run-audit after the response is sent.
  const inboundKey = req.headers.get("x-audit-secret");

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
  const trigger_source = payload.trigger_source ?? "airtable";

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

  if (!evidenceFolderId) {
    return jsonResponse(
      {
        error:
          `Engagement ${control.engagement_id} has no evidence_folder_id. ` +
          `Run register-engagement first.`,
      },
      400,
    );
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
      payload: { control_uuid: control.id, control_id: control.control_id },
      engagement_id: control.engagement_id,
    });
  } catch (err) {
    return jsonResponse(
      { error: `Failed to start job_run: ${(err as Error).message}` },
      500,
    );
  }

  const results: IngestFileResult[] = [];

  // All the slow work (Drive pull + per-file ingest, ~1-2 min) runs as a background
  // task so we ack the Airtable caller fast (well under its ~30s script cap) and then
  // chain to run-audit ourselves. Mirrors run-audit's own background pattern.
  // (Indentation inside is normalized by `deno fmt`.)
  const processSync = async (): Promise<Response> => {
  // Announce the pull on the control record (this function does the work, so it
  // owns the message). Survives an Airtable script timeout since we run here.
  await setStatus(airtableBase, control.airtable_record_id, "🔎 Pulling evidence from Google Drive…");

  try {
    // 1. Google Drive auth.
    const token = await getDriveAccessToken();

    // 2. Find the control's subfolder by name prefix (before the first "-").
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
        `📁 No evidence found for ${control.control_id} — ` +
          `please upload the evidence into the Additional Evidence field and re-run.`,
      );
      await failJobRun({
        handle: job,
        error_message: `No Drive subfolder for ${control.control_id}. ` +
          `Available: ${subfolders.map((f) => f.name).join(", ") || "(none)"}`,
      });
      return jsonResponse({
        error: `No evidence folder found for ${control.control_id} in Google Drive.`,
        control_uuid: control.id,
        total_files: 0,
        summary: { processed: 0, skipped: 0, failed: 0 },
        job_run_id: job.id,
      }, 422);
    }

    // 3. List the files in that subfolder (skip nested folders).
    const files = (await driveList(token, `'${match.id}' in parents and trashed = false`))
      .filter((f) => f.mimeType !== FOLDER_MIME);

    if (files.length === 0) {
      await setStatus(
        airtableBase,
        control.airtable_record_id,
        `📭 Evidence folder "${match.name}" is empty — add files in Google Drive and re-run.`,
      );
      // No files = no evidence to audit. Fail the step (422) so the per-control
      // script halts here and run-audit doesn't overwrite the 💬 above with a
      // cryptic "no linked extracted evidence" error.
      await failJobRun({
        handle: job,
        error_message: `Evidence folder "${match.name}" is empty`,
      });
      return jsonResponse({
        error: `Evidence folder "${match.name}" is empty — add files in Google Drive and re-run.`,
        control_uuid: control.id,
        subfolder: match.name,
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
    const pending = files.filter((f) => !doneNames.has(f.name));

    // Progress bar (Option B — server-rendered into 💬). Counts are CUMULATIVE across
    // self-chained runs: total = every file in the folder, done = already-ingested
    // (prior runs/chains) + completed this run — so the bar keeps advancing run to run.
    const totalFiles = files.length;
    const doneBefore = doneNames.size;
    let lastBarShown = -1; // monotonic guard so out-of-order PATCHes can't go backward
    await setStatus(airtableBase, control.airtable_record_id, progressBar(doneBefore, totalFiles));

    // 4. Process PENDING files concurrently, within a wall-clock budget. Each file:
    //    download → Storage → ingest. Up to EVIDENCE_CONCURRENCY at once; once
    //    SYNC_BUDGET_MS elapses we stop launching new ones (in-flight finish) and the
    //    rest are "deferred" → we re-invoke this function to continue (self-chaining),
    //    so a big control completes across runs instead of being killed mid-run.
    //    Zip archives are surfaced separately so the user gets an "unzip" nudge.
    const zipFiles: string[] = [];

    const processOneFile = async (f: DriveFile): Promise<IngestFileResult> => {
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
          error: "Zip archive — unzip the contents in Drive and re-upload.",
        };
      }

      let fileBytes: Uint8Array;
      try {
        fileBytes = await driveDownload(token, f.id);
      } catch (err) {
        return {
          status: "failed",
          filename: f.name,
          evidence_file_id: null,
          job_run_id: null,
          duration_ms: Date.now() - fileStart,
          error: `Drive download failed: ${(err as Error).message}`,
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

      // Ingest the same bytes we already downloaded (no re-download).
      const r = await ingestFile({
        engagement_id: control.engagement_id,
        control_id: control.id,
        file_path: storagePath,
        filename: f.name,
        file_bytes: fileBytes,
        trigger_source,
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
    const processWithTimeout = async (f: DriveFile): Promise<IngestFileResult> => {
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
              error: `File processing timed out after ${
                Math.round(PER_FILE_TIMEOUT_MS / 1000)
              }s (download/extraction did not return). The file may be too large or ` +
                `the extractor stalled — check the file in Drive and re-run.`,
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
    let nextIdx = 0;
    const worker = async (): Promise<void> => {
      while (nextIdx < pending.length) {
        if (Date.now() - startTime > SYNC_BUDGET_MS) return; // out of budget — defer the rest
        const idx = nextIdx++;
        results.push(await processWithTimeout(pending[idx]));
        const done = doneBefore + results.length;
        if (done > lastBarShown) {
          lastBarShown = done;
          await setStatus(airtableBase, control.airtable_record_id, progressBar(done, totalFiles));
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
      } else failed++;
      if (r.tokens) {
        totalInput += r.tokens.input;
        totalOutput += r.tokens.output;
        totalEmbedding += r.tokens.embedding;
      }
    }

    // Total usable evidence so far = already-done (pre-filtered out) + newly extracted
    // this run + any dedupe-skips. This is what the audit will see across all chains.
    const totalReady = doneNames.size + processed + alreadyIngested;
    const summary = {
      processed,
      skipped,
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
    // function to process the rest, and do NOT trigger run-audit yet. The pre-filter
    // means the next run skips what's done and continues with the remainder, so a big
    // control finishes across several runs instead of being killed mid-run.
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
          subfolder: match.name,
          summary,
          tokens,
          duration_ms,
          self_chained: true,
        },
      });
      await triggerFunction("sync-control-evidence", inboundKey, control.id);
      return jsonResponse({
        accepted: true,
        status: "processing",
        control_uuid: control.id,
        subfolder: match.name,
        total_files: files.length,
        summary,
        note: "More files pending; sync re-invoked itself to continue.",
        job_run_id: job.id,
      }, 202);
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
    const failureReasons = Array.from(reasonCounts.entries())
      .map(([reason, n]) => (n > 1 ? `${reason} (×${n})` : reason))
      .join(" | ");

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
        `(${zipFiles.join(", ")}). Please unzip the evidence in Google Drive and re-run.`;
    } else if (failed > 0) {
      statusMsg = `❌ Evidence could not be processed (${failed} file${plural(failed)} failed). ` +
        (failureReasons ? `Reason: ${failureReasons}` : `Check the files in Drive and re-run.`);
    } else {
      statusMsg = `📭 No evidence files found.`;
    }
    await setStatus(airtableBase, control.airtable_record_id, statusMsg);

    // Nothing usable (only zips / all failed) — halt 422 so run-audit doesn't run empty.
    if (totalReady === 0) {
      await failJobRun({
        handle: job,
        error_message: zipFiles.length > 0
          ? `No usable evidence — only zip file(s): ${zipFiles.join(", ")}`
          : `No usable evidence — ${failed} file(s) failed. Reasons: ${failureReasons || "(none captured)"}`,
      });
      return jsonResponse({
        error: statusMsg,
        control_uuid: control.id,
        subfolder: match.name,
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
        subfolder: match.name,
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

    // ATTACH the evidence files to the control FIRST, then write the Evidence Log
    // rows. Both happen here (not per-file during ingest) so attachments land
    // before the log, and so the whole set is mirrored correctly even when the
    // ingest spanned several self-chained runs.
    await finalizeControlEvidence({
      engagementId: control.engagement_id,
      controlId: control.id,
      baseId: airtableBase,
      controlRecordId: control.airtable_record_id,
    });

    // Everything ingested + attached + logged — chain to run-audit.
    await triggerFunction("run-audit", inboundKey, control.id);

    return jsonResponse({
      success: true,
      control_uuid: control.id,
      subfolder: match.name,
      total_files: files.length,
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
        job_run_id: job.id,
        note: "Evidence sync runs in the background; run-audit is triggered when it completes.",
      },
      202,
    );
  }
  return await processSync();
});
