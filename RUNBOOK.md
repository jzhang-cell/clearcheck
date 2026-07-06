# ClearCheck V3 — Runbook

> Operational guide for auditors and ops. If something's broken or you're onboarding a client, start here.

## Onboard a new engagement

1. Insert an `engagements` row (name, `attest_start`, `attest_end`, `airtable_base_id`, and `google_drive_id` / `evidence_folder_id` if pulling from Drive).
2. Create/identify the client's Airtable base; put its base id in `engagements.airtable_base_id`.
3. (Post-pilot) create the first user via `engagement_users`.
4. ⚠️ Seed **only** the 9 TSCs as reference data into prod — never Ecton test data.

## Add controls

1. Insert into `controls` (with `engagement_id`, `control_id` like `CC.01.02`, description, expected procedure).
2. Link to criteria via `control_tscs`.
3. Set `airtable_record_id` to the control's Airtable row id (required for write-back).
4. Run `refine-control` to populate the refined fields (also writes `V3_Refined_*` back to Airtable).

## Upload evidence

Evidence is pulled **automatically** by `sync-control-evidence` when a control's audit runs: it reads the control's Google Drive subfolder (named `<control_id>-…`), downloads each file to Supabase Storage at `evidence/{slug}/{control_id}/{filename}`, and ingests it (extract → embed → store), concurrently and in the background. There's no manual upload step in the normal flow — just make sure the files are in the right Drive subfolder.

## Trigger an audit (Airtable)

- **Single control:** open the control row in the V3 Demo base → tick **Run V3 Audit**. The automation runs **refine → audit**; fields populate ~30–60s later (refresh to see them).
- **Whole engagement:** tick **Run_All_V3_Audits** on the Audit Overview table → an automation ticks every control's box → each audits independently. ⚠️ Fires all at once — fine for small runs; for full engagements (56+ controls) a paced Supabase coordinator is still needed (see [DECISIONS.md](./DECISIONS.md) ADR-009).
- If `V3_Status` stays empty after ~90s, check `job_runs` for that control's latest row.

## Interpret results

Fields written back per control: `V3_Status`, `V3_Conformity_Level`, `V3_Determination`, `V3_Briefing`, `V3_Root_cause_analysis`, `V3_Root_cause_category`, `V3_Potential_clarifications`, `V3_Cost_USD`, `V3_Run_At`, `V3_Evidence` (attachments), `V3_Results` (workpaper). Plus `V3_Refined_*` from refine-control.

## Operator scripts

A few tasks run by hand from a checkout (these scripts are **not** deployed). Run them from the repo root with [Deno](https://deno.land). To target **production**, set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` to the prod project's values; omit them and the scripts hit the local stack (`http://127.0.0.1:54321`).

> ⚠️ The service-role key bypasses RLS. Never paste it into shared logs or commit it. Pull it from the Supabase dashboard (Project Settings → API) at run time.

### Maintain prompts — `scripts/sync-prompts.ts`

Pushes the prompt `.md` files in `supabase/prompts/` into the `prompts` table. **Run this after editing any prompt file** — the functions load prompts from the DB at runtime, so an edited file does nothing in prod until it's synced. For each key it deactivates the prior active row, then upserts the new version.

```bash
SUPABASE_URL=https://<prod-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<prod-service-role-key> \
deno run --allow-read --allow-env --allow-net scripts/sync-prompts.ts
```

### Mint / rotate a per-engagement key — `scripts/mint-engagement-key.ts`

Mints (or rotates) the per-engagement API key for an existing engagement that predates `register-engagement`'s auto-minting. Stores only the SHA-256 hash on `engagements.api_key_hash` and prints the plaintext **once** — copy it into the engagement's Airtable `supabase_key` field.

```bash
SUPABASE_URL=https://<prod-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<prod-service-role-key> \
deno run --allow-read --allow-env --allow-net \
  scripts/mint-engagement-key.ts <engagement-uuid>
```

> The old client-side ingest scripts (`orchestrate-ingest.ts`, `sync-drive-evidence.ts`) were **retired 2026-06-27** — evidence ingest now runs server-side inside `sync-control-evidence`.

**Dev-only (not operational):** `scripts/upload-fixtures.ts` uploads local test files into the `evidence` bucket; `scripts/test-claude-parse.ts` unit-tests the `claude-parse.ts` parser. Neither is needed to run a production engagement.

## Common errors

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 Unauthorized` | missing/wrong `x-audit-secret` | send the prod `AUDIT_SHARED_SECRET` |
| `run-audit` HTTP 400 | control not refined | run `refine-control` first (`refinement_status='refined'`) |
| `WORKER_RESOURCE_LIMIT` (546) | wall-clock ceiling on a long sync | `sync-control-evidence` is async + ingests files concurrently; raise `EVIDENCE_CONCURRENCY` or background more if a control has very many files |
| `422` from Airtable | field/table name mismatch | verify field names + `airtable_record_id` |
| OpenAI `429` | embeddings quota | retry / check OpenAI billing |
| `<scratchpad>` parse failure | flaky model output (missing tags) | re-run the audit (usually transient) |
| empty `V3_*` after run | audit errored or write-back skipped | check `job_runs.error_stack` + `airtable_sync.skip_reason` |

## Who to contact

- **Supabase project / deploys:** Jordan (deeAI Solutions).
- **Anthropic / OpenAI / Airtable billing:** Decrypt.
- **Google Workspace / Drive admin (Domain-Wide Delegation):** Decrypt Workspace Super Admin.
