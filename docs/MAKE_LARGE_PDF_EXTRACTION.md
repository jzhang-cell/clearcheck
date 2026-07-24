# Make.com large-PDF extraction

ClearCheck can offload only PDFs over 50 pages to Make.com. Supabase still owns
file hashing, deduplication, Storage, embeddings, database writes, control links,
Evidence Log/V3 attachments, and the durable audit queue.

This path is opt-in. If either Make environment variable is absent,
`ingest-evidence` uses the existing Supabase/Claude extractor.

## Flow

1. `sync-control-evidence` first checks the Airtable control's `V3_Evidence`
   attachment field. If it is non-empty, those attachments are downloaded and
   Google Drive is skipped. If it is empty, the function pulls the control's
   Google Drive folder as before. Every file is uploaded to the private Supabase
   `evidence` bucket.
2. `_shared/ingest-file.ts` detects `pdf_large`, creates an
   `external_extraction_jobs` row, and calls the Make webhook once.
3. Make downloads the file from the source selected by `file.source`: Google
   Drive using `file.google_drive_file_id`, or HTTP using
   `file.download_url` for an Airtable attachment. It extracts the text, chunks
   that text, and runs the supplied Stage 1 prompt once per chunk.
4. Make aggregates the Stage 1 JSON results and runs the supplied Stage 2 prompt
   once to produce the final document-level extraction.
5. Make POSTs that final structured result to `make-extraction-callback`.
6. The callback generates the OpenAI embedding, inserts the normal
   `extracted_evidence` row, links the file to the control, and marks the file
   extracted.
7. Once every external job in the sync is complete, the callback resumes
   `sync-control-evidence`. That function performs its existing finalization and
   enqueues the normal audit. Make must **not** write Supabase tables or call
   `run-audit` itself.

## Make scenario

Create one scenario with these modules:

1. **Webhooks → Custom webhook**
   - Copy its URL into `MAKE_LARGE_PDF_WEBHOOK_URL`.
   - Reject requests whose `x-clearcheck-secret` header does not equal the shared
     Make secret.
   - Configure the webhook to acknowledge within 15 seconds. If that is not
     possible, increase `MAKE_WEBHOOK_TIMEOUT_MS`.
2. **Router → download from the supplied source**
   - When `file.source` is `google_drive`, use **Google Drive → Download a
     file** with `file.google_drive_file_id`. The Make Google Drive connection
     must have access to the Shared Drive that contains the evidence.
   - When `file.source` is `download_url`, use **HTTP → Download a file** (or
     **HTTP → Get a file**) with `file.download_url`.
   - Feed the downloaded binary from either route into the same downstream PDF
     extraction module.
3. **PDF/text extraction and chunking**
   - Use Make AI Content Extractor or another PDF service to extract the entire
     document downloaded by the previous module.
   - Split the text into chunks suitable for the model, then send those chunks
     through an Iterator. Make, rather than the webhook sender, owns the exact
     chunking method and chunk size.
4. **Claude Stage 1 — one call per chunk**
   - System prompt: `extraction.step_1.system_prompt`.
   - User prompt: start from `extraction.step_1.user_prompt_template` and replace
     its placeholders using this mapping:

| Prompt placeholder | Make value |
| --- | --- |
| `{{control_description}}` | `control.description` |
| `{{tscs}}` | `control.tscs` |
| `{{expected_procedures}}` | `control.expected_procedures` |
| `{{evidence_text}}` | Current Iterator chunk text |
| `{{chunk_number}}` | Current Iterator position, starting at 1 |
| `{{total_chunks}}` | Total number of chunks |

   - Model and output limit: `extraction.step_1.model` and
     `extraction.step_1.max_tokens`.
   - The model returns a `<scratchpad>...</scratchpad>` block followed by JSON.
     Keep the JSON object as the chunk extraction; do not pass the scratchpad into
     the Stage 2 array.
5. **Array aggregator**
   - Collect every parsed Stage 1 JSON object, in original chunk order, into one
     JSON array.
6. **Claude Stage 2 — one call after aggregation**
   - System prompt: `extraction.step_2.system_prompt`.
   - User prompt: start from `extraction.step_2.user_prompt_template` and replace
     its placeholders using this mapping:

| Prompt placeholder | Make value |
| --- | --- |
| `{{control_description}}` | `control.description` |
| `{{tscs}}` | `control.tscs` |
| `{{expected_procedures}}` | `control.expected_procedures` |
| `{{evidence_name}}` | `file.filename` |
| `{{chunk_extractions}}` | JSON-stringified Array aggregator output |

   - Model and output limit: `extraction.step_2.model` and
     `extraction.step_2.max_tokens`.
   - The model again returns `<scratchpad>...</scratchpad>` followed by JSON.
     Parse the JSON after the closing tag. This final Stage 2 JSON—not an
     individual chunk result—is the callback's `extracted_content`.
7. **HTTP → Make a request** to the supplied `callback.url`
   - Method: `POST`
   - Header: `x-make-secret: <the same MAKE_WEBHOOK_SECRET>`
   - Content type: `application/json`
   - Success body:

```json
{
  "job_id": "{{job_id}}",
  "status": "completed",
  "provider_execution_id": "{{Make execution id}}",
  "provider_execution_url": "{{Direct Make execution URL}}",
  "extracted_content": { "file_metadata": {}, "scope_check": {}, "tsc_content_mapping": [] },
  "raw_extracted_text": "full Stage 2 Claude output",
  "scratchpad": "text captured from the Stage 2 scratchpad, or null",
  "input_tokens": 0,
  "output_tokens": 0
}
```

Drive jobs remain on webhook contract version 3 for backward compatibility.
Airtable `V3_Evidence` jobs use version 4 (`contract_version: 4`). The common
file locator is:

```json
{
  "source": "google_drive | download_url",
  "google_drive_file_id": "set for Drive files, otherwise null",
  "download_url": "set for V3_Evidence files, otherwise null"
}
```

For `download_url`, ClearCheck sends a 24-hour signed URL for only the uploaded
evidence object; it never sends a Supabase service credential. Prompt text and
model settings are loaded from the active `extractor_pdf_chunk` and
`extractor_pdf_aggregator` rows in ClearCheck's prompt library for every new job,
so the Make scenario does not need a copied, independently maintained prompt.
The callback stores the Stage 2 aggregator prompt ID on `extracted_evidence`
because Stage 2 produced the final document-level JSON.

Add a Make error handler that calls the same callback with HTTP `POST`:

```json
{
  "job_id": "{{job_id}}",
  "status": "failed",
  "provider_execution_id": "{{Make execution id}}",
  "provider_execution_url": "{{Direct Make execution URL}}",
  "error": "short actionable failure reason"
}
```

The callback is idempotent. Make may retry a `completed` callback after a 5xx.
Do not retry the initial inbound ClearCheck webhook: the database job row is the
dispatch source of truth, and an ambiguous retry could start duplicate Make work.

If a Make callback is lost, the sync remains visibly `waiting_external`. The
scheduled `sweep-stuck-jobs` watchman closes external jobs that have produced no
callback for two hours (`MAKE_EXTERNAL_STALE_MS`, default `7200000`) and writes
an actionable retry message to the control. A new Run V3 request reuses a
healthy wait; after the same stale cutoff it may safely start a fresh cycle.
The two-hour default is intentionally conservative because healthy 100+ page
reports have taken roughly 40 minutes.

## Deploy

From the repository root:

```bash
supabase link --project-ref kwuymtlpjkziqkumixvk
supabase db push
supabase secrets set \
  MAKE_LARGE_PDF_WEBHOOK_URL='https://hook.us1.make.com/…' \
  MAKE_WEBHOOK_SECRET='use-a-long-random-secret'
supabase functions deploy sync-control-evidence make-extraction-callback \
  --project-ref kwuymtlpjkziqkumixvk
```

Deploying `sync-control-evidence` bundles the changed `_shared/ingest-file.ts` and
`_shared/external-extraction.ts` modules.

## Test and observe

Trigger **Run V3** on one control containing a PDF over 50 pages. In Supabase
Studio, inspect:

```sql
select id, status, total_files, error_message, created_at, completed_at
from evidence_sync_runs
order by created_at desc
limit 20;

select id, sync_run_id, filename, status, attempts,
       provider_execution_id, provider_execution_url, error_message,
       queued_at, started_at, completed_at
from external_extraction_jobs
order by queued_at desc
limit 50;

select function_name, status, payload, result, error_message, started_at, completed_at
from job_runs
where function_name in (
  'ingest-evidence', 'make-extraction-callback', 'sync-control-evidence'
)
order by started_at desc
limit 100;
```

Expected state sequence:

`evidence_sync_runs`: `dispatching` → `waiting_external` → `resuming` → `completed`

`external_extraction_jobs`: `queued` → `processing` → `completing` → `completed`

The `ingest-evidence` job should finish quickly with
`result.queued_external = true`; it should not remain `running` while Make works.

## Current scope

The external branch is enabled for the Google Drive **Run V3 / sync-control-evidence**
path, because that caller has a durable sync to resume. `rerun-audit` additional
attachments currently keep the existing local extractor path; do not pass a
`sync_run_id` from that function until it has its own durable continuation.
