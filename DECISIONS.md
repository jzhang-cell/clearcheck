# ClearCheck V3 — Architecture Decision Records

> Each ADR captures a non-obvious decision: what we picked, what we considered, why, and what would make us revisit.

---

## ADR-001: Supabase over Vercel + Neon + S3

- **Decision**: Build on Supabase (Postgres + Edge Functions + Storage + Vault) as one platform.
- **Considered**: Vercel functions + Neon Postgres + S3 storage stitched together.
- **Rationale**: One platform = one auth model, built-in Storage + Vault + pgvector, less glue code, faster to ship the pilot.
- **Revisit if**: edge-function limits (worker ceiling, cold starts) block scale and a dedicated compute tier is needed.

---

## ADR-002: Claude over GPT-4o

- **Decision**: Use Claude across extraction, judgment, and rendering.
- **Considered**: GPT-4o / OpenAI models.
- **Rationale**: Stronger long-document reasoning and instruction-following for audit judgment; clean tiered family (Haiku/Sonnet/Opus). OpenAI still used for embeddings.
- **Revisit if**: a competing model materially beats Claude on audit-judgment quality or cost.

---

## ADR-003: Tier models (Haiku / Sonnet / Opus) vs single model

- **Decision**: Haiku for extraction/refine, Opus for judgment, Sonnet (temp 0) for workpaper.
- **Considered**: one mid model for everything.
- **Rationale**: Extraction is high-volume and cheap (Haiku); judgment is the quality gate (Opus); rendering needs deterministic prose (Sonnet temp 0). Best cost/quality per stage.
- **Revisit if**: per-control cost or quality shifts the optimal split.

---

## ADR-004: Shared-secret auth Phase 1 vs JWT

- **Decision**: `verify_jwt=false` + `x-audit-secret` header for the pilot.
- **Considered**: full per-user JWT auth now.
- **Rationale**: `sb_publishable_*` keys aren't JWTs; Airtable automations just need to call a webhook. Shared secret unblocks the pilot; JWT is Phase 2.
- **Revisit if**: real per-user identity/attribution is needed, or before opening beyond trusted callers.
- **Update (ADR-011)**: the single shared secret is being replaced by **per-engagement API keys** (still header-based, still not JWT). Full per-user JWT remains deferred.

---

## ADR-005: Airtable as Phase 1 frontend

- **Decision**: Keep Airtable as the auditor UI; V3 writes `V3_*` fields back.
- **Considered**: a custom web frontend.
- **Rationale**: Auditors already live in Airtable; zero retraining; fastest path to a usable product. Automations bridge button → function.
- **Revisit if**: Airtable's limits (30s scripts, automation concurrency) block core workflows at scale.

---

## ADR-006: Staged infra (free → Pro → queue) vs build queue upfront

- **Decision**: Ship on free/Pro now; defer an external queue.
- **Considered**: building Inngest/Trigger.dev orchestration from day one.
- **Rationale**: Pilot volume doesn't need a durable queue; premature infra is wasted effort. Documented triggers tell us when to move tiers.
- **Revisit if**: sustained >3 concurrent batches, >24h ingest backlog, or a reliability incident traced to the in-function coordinator.

---

## ADR-007: Self-orchestrated batching for pilot, external queue deferred

- **Decision**: Coordinate batches inside functions (`ingest-evidence-batch` + per-file fanout) for the pilot.
- **Considered**: external queue immediately.
- **Rationale**: In-platform fanout is enough for pilot volume and keeps everything in Supabase.
- **Revisit if**: the migration triggers in ADR-006 fire.

---

## ADR-008: RLS isolation via session badge + scoped role (in progress)

- **Date**: 2026-06 (foundation committed; function rewiring pending)
- **Decision**: Enforce per-engagement isolation with RLS policies that read a per-request session GUC `app.current_engagement_id`, applied to a non-bypass `engagement_scoped` role the functions will use for client data. Implemented as **Label (0005) → Lock (0006) → Restrict foundation (0007)**, then Stamp + Restrict in the functions.
- **Considered**: (a) keep relying on `WHERE engagement_id = …` in code (no DB enforcement); (b) per-user JWT + PostgREST RLS now.
- **Rationale**: Code-only filtering is one forgotten clause away from a cross-client leak — unacceptable for compliance data. A DB-enforced lock can't be forgotten. The GUC/scoped-role mechanism aligns with the policies and avoids the JWT-key uncertainty for the pilot's machine caller.
- **Status / risk**: foundation done + adversarially proven; **functions still use `service_role` (bypasses RLS), so isolation is NOT yet live.** Safe only because prod has one client. **Gating item before a second client's data lands.**
- **Revisit if**: we move to per-user JWTs (the human path via `user_engagement_ids()` is already in the policies), or if direct-Postgres scoped connections prove unworkable from edge functions.
- **Update**: the "Stamp + Restrict" rewiring is now the active ticket — see **ADR-011**, which combines it with per-engagement keys.

---

## ADR-009: Master "Run All" — Airtable fan-out now, paced Supabase coordinator later

- **Date**: 2026-06
- **Decision**: For now, the `Run_All_V3_Audits` checkbox uses an Airtable automation that ticks every control's box (each fires its own audit). For full scale, move the looping into a paced Supabase coordinator (`run-engagement-audit`) with bounded concurrency.
- **Considered**: (a) a single Airtable script that loops and calls run-audit 56× (dies at the 30s limit); (b) firing all at once (current — fine for small N).
- **Rationale**: Ticking boxes is instant so the master script avoids the 30s wall, but firing 56 audits simultaneously slams Claude rate limits and spikes cost. A backend coordinator paces the work and has no 30s cap.
- **Revisit if**: engagements routinely exceed a handful of controls — then build the coordinator before running them at scale.

### ADR-009 update (2026-06): `run-audit` acks fast, runs in the background

- **Decision**: `run-audit` no longer runs its 1–2 min Opus/Sonnet/write-back pipeline inline. It validates + starts the job, dispatches the pipeline via `EdgeRuntime.waitUntil`, and returns a **202 "processing" ack** with `job_run_id`. The audit self-reports to Airtable on completion; outcome is tracked in `audit_runs`/`job_runs`. Falls back to inline-await when no background runtime exists (local serve, tests).
- **Why**: the per-control Airtable script (ADR-012 step 4.2) awaits each call, and a full audit would exceed Airtable's ~30s script cap; worse, a dropped connection can terminate an Edge Function mid-pipeline. Backgrounding keeps the caller fast and the work safe. This is the lightweight, per-call version of ADR-009's "no 30s cap" goal — not the full paced coordinator, which is still deferred.
- **Known gap**: `sync-control-evidence` is still synchronous and can approach the cap for controls with many evidence files. Background it the same way if it bites — or fold both into the async queue (ADR-006/007).

---

## ADR-010: Google Drive auto-pull via service account

- **Date**: 2026-06
- **Decision**: Pull evidence from each engagement's Drive folder using a Google service account (`drive.readonly`), mapping subfolders (`<control_id>-…`) to controls, into Supabase Storage (`scripts/sync-drive-evidence.ts`).
- **Considered**: manual upload (status quo); per-user OAuth.
- **Rationale**: A service account is unattended and fits an automated pipeline; folder-name prefix gives a clean control mapping.
- **Status**: built but **blocked** — the Shared Drive is members-only, so access needs a Workspace Super Admin to authorize Domain-Wide Delegation. Then add `subject: jzhang@decrypt.cpa` to the JWT.
- **Revisit if**: the org won't grant DWD — fall back to per-user OAuth or a shared-with-SA folder outside the Shared Drive.

---

## ADR-011: Un-defer multi-engagement isolation — RLS enforcement + per-engagement keys (one ticket)

- **Date**: 2026-06
- **Decision**: Lift the deferral in Critical Rule 5 and ship, as **one combined ticket**, both halves of true tenant isolation:
  1. **RLS enforcement (the "Stamp + Restrict" step from ADR-008)** — for client-data operations the functions stop using the `service_role` master key and instead operate as the non-bypass `engagement_scoped` role with `app.current_engagement_id` set per request, so the 0006 policies actually bite.
  2. **Per-engagement API keys** — replace the single `AUDIT_SHARED_SECRET` with a per-engagement secret stored on the `engagements` row. **The inbound key maps to exactly one engagement** (key-→-engagement lookup), so a single header value both (a) authenticates the caller and (b) tells us which engagement to stamp for RLS. One leaked key burns one client, not all.
- **Considered**:
  - (a) Keep deferred — rejected: a second client's data is imminent and ADR-008 names this the gating item.
  - (b) RLS enforcement only, keep the one shared secret — viable, but leaves the whole platform behind a single key (full blast radius) and still needs an explicit `engagement_id` in every payload.
  - (c) Per-engagement keys only, no RLS enforcement — rejected: a fancy outer key over a room the master key still reads from; isolation stays code-only.
  - Sequencing: do them **together** rather than RLS-first-then-keys, because the per-engagement key conveniently supplies the engagement identity the Stamp needs — building them separately would mean wiring engagement resolution twice.
- **Rationale**: The key-→-engagement mapping makes the two halves reinforce each other: authentication and the RLS badge come from the same lookup. DB-enforced isolation can't be forgotten; per-engagement keys cap the blast radius. Still header-based and machine-friendly for the Airtable caller — no JWT.
- **Main implementation fork (RESOLVED 2026-06 → (a) Direct Postgres)**: chose the direct-Postgres path through the transaction-mode pooler (port 6543, prepared statements off), running each client-data unit of work in a transaction with `set_config('app.current_engagement_id', …, true)` + `SET LOCAL ROLE engagement_scoped`. Rejected (b) short-lived JWT: more moving parts now, and likely infeasible against prod's asymmetric JWT signing (no in-function HS256 secret). The `postgres` npm lib is already in `deno.json` and the `SUPABASE_DB_URL` env var is already injected, so the prereqs are in place. Next code step: build `_shared/scoped-db.ts` + `withEngagementScope`, pilot on `refine-control`. The original fork, for the record:
  - **(a) Direct Postgres connection** (e.g. the `postgres` npm lib already in `deno.json`, or `SUPABASE_DB_URL` which edge functions auto-inject) that runs each client-data unit of work inside a transaction with `set_config('app.current_engagement_id', …, true)` + `SET LOCAL ROLE engagement_scoped`. *(Leaning this way — it matches the 0007 comment "so the function's DB connection (role `postgres`) can SET ROLE to it", and the prereq env var is already available. NOTE: must route through the transaction-mode pooler (port 6543) with prepared statements off.)*
  - **(b) Short-lived JWT** carrying the role + an engagement claim, used with PostgREST. Closer to the eventual per-user JWT story but more moving parts now — and may be infeasible if prod uses Supabase's newer asymmetric JWT signing keys (no shared HS256 secret to sign with in-function).
  This choice drives the rewrite of `_shared/supabase-client.ts` and how every function does client-data reads/writes. System tables (`prompts`, `job_runs`) stay on `service_role`.
- **Scope / new artifacts (planned)**: a migration adding the per-engagement key column to `engagements` (stored hashed, via `pgcrypto`) + backfill for the existing prod engagement; a new `_shared/auth.ts` path (`resolveEngagementByKey`) replacing/augmenting `checkSharedSecret`; the scoped DB client (`_shared/scoped-db.ts`, helper `withEngagementScope`); and Airtable automations updated to send each engagement's own key. Each Edge Function's handler header changes from "authenticate" to "authenticate **and** resolve engagement + stamp."
- **Status (2026-06)**: **half 2 (per-engagement keys) foundation built; half 1 (RLS enforcement) still pending.**
  - **Done (keys):** migration `0008_engagement_api_keys.sql` (`api_key_hash` + `api_key_set_at` on `engagements`, unique index, SHA-256 hash only — done in Web Crypto so plaintext never reaches Postgres, *not* `pgcrypto` as originally sketched); `_shared/engagement-key.ts` (generate/hash); `register-engagement` mints + returns the key once on create and scrubs it from `job_runs`; `auth.resolveEngagementByKey()` (hash inbound → resolve the one owning engagement); `scripts/mint-engagement-key.ts` (backfill/rotate for the seeded prod engagement).
  - **Still pending (keys):** mint the prod engagement's key via the script; flip the per-engagement functions' auth from `checkSharedSecret` → `resolveEngagementByKey` (deferred to the RLS cutover so prod doesn't half-break); Airtable sends each engagement's own key.
  - **Still pending (RLS, half 1):** the `_shared/scoped-db.ts` + `withEngagementScope` helper and the client-data conversion across 4 functions + `_shared/ingest-file.ts` (~20 queries incl. a pgvector insert and the `control_tscs→tscs` join). Build plan unchanged: pilot `refine-control` + the helper, prove isolation locally, then fan out. **§0 fork RESOLVED 2026-06 → direct Postgres (pooler 6543, prepared statements off); ready to build.**
- **Revisit if**: the direct-Postgres path proves unworkable from edge functions (fall back to JWT claims), or when per-user JWT auth lands (the human path via `user_engagement_ids()` is already in the 0006 policies and can coexist).

---

## ADR-012: Drive-driven button workflow — `register-engagement` + `sync-control-evidence` (planned)

- **Date**: 2026-06
- **Status**: **PLANNED — not yet built.** Captures the agreed target workflow so the two new functions and the file-level impact are on record before implementation.
- **Decision**: Make the Airtable `[Run V3]` button drive the *entire* pipeline — including pulling evidence from Google Drive — instead of relying on manual laptop scripts (`sync-drive-evidence.ts` + `orchestrate-ingest.ts`) to pre-stage evidence. Two new Edge Functions are introduced and the existing ones are left unchanged.
  - **Target flow**:
    - **Team (manual):** (1) upload evidence to Google Drive; (2) fill the Airtable Overview row with `google_drive_id`, `evidence_folder_id`, `engagement_id`.
    - **Button [Run V3]:**
      - **4.1** `POST register-engagement { engagement_id, google_drive_id, evidence_folder_id }` — **once per engagement** → saves the Drive IDs onto the `engagements` row.
      - **4.2** for each control, in order: `sync-control-evidence { control_id }` → `refine-control { control_id }` → `run-audit { control_id }`.
  - **Why two functions, not one, and why not inside `run-audit`**: evidence fetch + ingestion is the slow/expensive stage (Drive download + Claude extract + embeddings) and is exactly what `orchestrate-ingest.ts` exists to keep off the timeout path; burying it inside `run-audit` would reintroduce the ~150s worker-ceiling risk and couple ingestion failures to audit failures. Keeping it a separate per-control step preserves clean retries and keeps `run-audit` pure ("evidence is ready → judge it").
  - **Important correction recorded**: evidence for the audit must land in **Supabase Storage + `extracted_evidence`** — NOT in Airtable. The Airtable `V3_Evidence` field is only a display mirror (signed-URL attachments) that `run-audit` writes back at the end. The new workflow changes only the *source* of evidence (Google Drive instead of manual upload); every downstream step is identical.
- **Function contracts (PINNED 2026-06)** — all calls are server-to-server from the Airtable automation; auth is the same `x-audit-secret` shared-secret header as every existing function (until ADR-011 per-engagement keys land):
  - **`register-engagement`** — called **once per engagement** at the start of the button run.
    - Body: `{ engagement_id, google_drive_id, evidence_folder_id }`
    - Effect: UPDATE the `engagements` row with the two Drive IDs. Idempotent (re-running just overwrites with the same values).
    - `trigger_source` recorded as `"airtable"` (default; accept an optional body override for hand/debug calls).
  - **`sync-control-evidence`** — called **once per control**, and **must complete before `run-audit`** for that control (run-audit hard-fails on empty `extracted_evidence`).
    - Body: `{ control_id }` — the control's UUID (`controls.id`), and the ONLY field expected.
    - Caller: Airtable POST webhook (the `[Run V3]` button). `trigger_source` is NOT sent in the body; the function stamps it `"airtable"` by default (`body.trigger_source ?? "airtable"`, matching the codebase's `?? "manual"` pattern so hand/debug calls can override and be told apart in `job_runs`).
    - Effect: resolve control → engagement → `evidence_folder_id` + slug; find the Drive subfolder whose name prefix (before the first `-`) equals `controls.control_id` (the `CC.01.02` code); download each file; upload to `evidence/{slug}/{control_id}/{filename}`; call `ingestFile()` per file (extract → embed → store → dedupe → link → job_runs). Returns a per-file summary (processed/skipped/failed + tokens), same shape as `ingest-evidence-batch`.
    - Ordering guard: if the engagement's `evidence_folder_id` is null, fail clearly ("engagement not registered; run register-engagement first") — this enforces the 4.1-before-4.2 sequence.
  - **Sequencing requirement**: the Airtable automation must run 4.2's three calls **sequentially per control** (await each), not fire-and-forget, because each step depends on the previous one's DB writes.
- **File-level impact (planned)**:
  - **NEW** `supabase/functions/register-engagement/index.ts` — tiny handler; one UPDATE of `engagements`. Reuses `auth.ts`, `supabase-client.ts`, `job-run.ts`. No migration (columns exist since 0003).
  - **NEW** `supabase/functions/sync-control-evidence/index.ts` — per-control: find Drive subfolder → download files → `ingestFile()` each. Reuses `_shared/ingest-file.ts` (the key reuse — file-bytes → extract → embed → store already exists). `ingestFile` accepts `file_bytes` directly, so each Drive file is downloaded once and handed to both the Storage upload and the ingest (no double-download).
  - **NEW** `supabase/functions/_shared/drive-client.ts` — the Google service-account auth + Drive list/download logic ported out of `scripts/sync-drive-evidence.ts` so a deployed function (no local filesystem) can use it.
  - **UPDATE** `supabase/config.toml` — register both new functions with `verify_jwt = false`.
  - **UPDATE** `supabase/functions/_shared/engagement-slug.ts` — today the slug map is hardcoded to Ecton (`11111111-… → "ecton"`) and THROWS for any unmapped engagement; with 3 real engagements it must derive the slug from the `engagements` row instead of a constant map. Leaning toward a new `engagements.slug` column (small migration + backfill) for readable Storage folders; fallback is to use `engagement_id` itself as the prefix (no migration, uglier paths).
  - **NEW secret** `GOOGLE_SA_JSON` in Vault — the service-account key (the script reads it from a local file today; a deployed function cannot).
  - **UNCHANGED**: `refine-control`, `run-audit`, `ingest-evidence`, `ingest-file.ts`. The new workflow *prepends* steps; it does not rewrite existing ones.
  - **Outside the repo**: the Airtable automation (button → the 4 calls, sequential per control) and the Overview-table fields; plus the ADR-010 Drive-access (DWD) grant, which still gates `sync-control-evidence` from actually downloading.
- **Considered**: (a) keep manual laptop scripts for evidence staging (status quo — doesn't scale to a one-click client run); (b) fold Drive-fetch + ingestion into `run-audit` (rejected — timeout + failure-coupling, see above); (c) one engagement-level function that ingests *all* controls at once (rejected — blows the worker ceiling; per-control keeps each call short).
- **Depends on / revisit if**: blocked by the same Google DWD grant as ADR-010. If per-engagement scale grows, the per-control 4.2 loop may want the paced coordinator from ADR-009. Field names on the Airtable side (`google_drive_id` etc.) are approximate and to be finalized during build.

### ADR-012 update (2026-06): `register-engagement` is the engagement-setup boundary (create-and-write-back)

- **What changed**: `register-engagement` is now a true **upsert** — on first call it CREATES the engagement row (Postgres mints the UUID), dedupes on `airtable_record_id` (stored in `engagements.airtable_base_id`), and returns the UUID so Airtable writes it back to a `supabase_uuid` field. Previously rows only existed via `seed.sql`.
- **Why this is recorded here**: the create-and-write-back flow lands on the seam of ADR-011 (RLS + per-engagement keys) and the `engagements.slug` question. Pinning the boundary so the isolation ticket doesn't have to rediscover it:
  1. **`register-engagement` is a system/`service_role` setup operation, exempt from the RLS badge.** It writes a brand-new engagement row *before* any `engagement_scoped` badge for that engagement could exist — so it cannot wear the badge. Consistent with ADR-011's "system tables stay on `service_role`." Every **downstream** per-engagement call (sync-control-evidence, refine-control, run-audit) is where the badge + `app.current_engagement_id` stamp apply, using the UUID this function minted.
  2. **The create branch is the future mint point for per-engagement keys.** When ADR-011 resumes, key generation (random → `pgcrypto` hash stored on the row → plaintext returned **once**, only on create) belongs in `register-engagement`'s INSERT path, symmetric with the existing `supabase_uuid` write-back. Update path never returns a key (can't un-hash).
  3. **`engagements.slug` is now optional/deferred.** With the UUID auto-generated and `engagement-slug.ts` already falling back to the UUID, new clients get a working Storage path with zero config. The slug column is purely cosmetic (readable folders) and no longer gates onboarding — defer it.

### ADR-012 caller update (2026-08): Make.com owns registration

- **Decision:** The existing Make onboarding scenario is the sole caller of
  `register-engagement`. It already holds the client metadata, attestation dates,
  Google Drive IDs, and Airtable identifiers the endpoint requires.
- **Ordering:** Make registers the engagement and saves `supabase_uuid` plus the
  create-only `supabase_key` to the Audit Overview row; C2C reads that saved key;
  the Airtable master script verifies both values are present and then starts
  Run V3.
- **Key safety:** Make must preserve the existing Airtable key whenever an
  idempotent update response omits `api_key`. The plaintext is returned only on
  creation and cannot be recovered from its stored hash.
- **Auth boundary:** The shared `AUDIT_SHARED_SECRET` lives in Supabase and in
  Make's secured HTTP credentials. It is not stored in Airtable. Downstream C2C
  and per-control calls continue to use only the per-engagement key.

---

## ADR-013: Re-run as a remediation (delta) pass — `rerun-audit` + `audit_remediation` prompt

- **Date**: 2026-06-29
- **Status**: **BUILT on branch `claude/todo-item-5-r7o39e` — not yet deployed.** Implements NEXT_STEPS §5 ("re-run & richer audits").
- **Context**: After a first audit, an auditor often wants to *close a gap* — they unzip a file, add a missing artifact, or explain context the model misread. The naïve approach is "re-judge everything," but that re-pulls Drive, re-reads all evidence, and re-pays the full Opus cost to re-derive a conclusion we already have.
- **Decision**: A re-run is a **remediation pass over the delta**, not a fresh audit. It takes the **PREVIOUS verdict** + **only the new evidence/notes** the auditor just staged in Airtable, and a dedicated `audit_remediation` prompt (Rules 1–12, "first match wins") decides whether the new material **overturns / closes / fails to close** the prior gap, emitting a `Previous → New` status. This is why it can safely **skip Google Drive** — the old evidence's conclusion is already captured in the previous determination.
  - **Trigger**: a new Airtable single-select **`Re-run Audit 🤖`** on the control row, separate from the initial `Run V3 Audit` (Drive) button. Two options: *run with Additional Evidence* / *run with Additional Notes* → `mode` hint. **Forgiving**: whatever is staged is used regardless of the option (attachments ingested if present, notes included if present); the option only colors the 💬 wording.
  - **Evidence source**: the auditor drops files into an Airtable **`[Additional Evidence]`** attachment field (NOT Drive) and types into **`[Additional Notes]`**. The re-run script passes the attachment `{url, filename}` list + notes to `rerun-audit`, which downloads → Storage → `ingestFile()` (same shared module + hash dedup) → links to the control.
  - **Reconciliation by notes, not DB**: because a re-run is purely additive (we never unlink old evidence and only the *delta* reaches the judge), a *corrected* file living alongside the stale one is handled by the **auditor notes steering the model** (e.g. "the prior policy was superseded"), not by deleting links. This sidesteps a DB-level "link reconciliation" mechanism for the re-run path.
- **Output compatibility**: the remediation prompt reuses the audit_judge XML-tag contract (`<conformity_level>`, `<root_cause>`, `<determination>`, `<briefing>`, `<clarifications>` inside `<scratchpad>`) so the shared `claude-parse.ts` and the Airtable `V3_*` write-back are reused unchanged. The one new verdict value, **`Incomplete Assessment`** (Rule 11 — unreadable/wrong file type), is registered in `claude-parse.ts`'s status map.
- **Evidence write-back** (two places, both like the initial run):
  1. **`[Evidence Log]` table** — each additional file writes a per-file row (Filename, File Type, File_Size, Processing Status, tokens, Extracted_Data, Scratchpad, Evidence_Note, linked Control), reusing the same mapping as `sync-control-evidence`'s `createEvidenceLogRow`, with the **`Additional Evidence` checkbox ticked** so re-run files are distinguishable from initial-run files. (`Token cost` is left unset — `sync` doesn't set it either.)
  2. **`V3_Evidence` attachment box on the control** — **rebuilt from the control's full linked evidence set** (initial + additional) via signed URLs generated from the DB (the source of truth), not a read-merge against Airtable. A full PATCH is correct because we send the *complete* set, so it can't drop the initial attachments; `V3_Evidence_Count` is updated to match, and the field is **omitted** (never sent as `[]`) when there are no files.
  *(Decision updated 2026-06-29 — the first cut skipped both; "evidence write-back" was clarified to mean the Evidence Log row primarily, plus keeping the attachment box complete.)*
- **History**: each re-run records a fresh `audit_runs` row tagged `run_type='remediation'` with `previous_audit_run_id` pointing at the verdict it supersedes and `auditor_notes` captured (migration 0010). `controls.latest_audit_run_id` advances to the re-run, so the displayed verdict is always the most recent.
- **Why a separate function, not a `mode` on `run-audit`**: the inputs (previous verdict + delta vs. full evidence set), the evidence source (Airtable attachments vs. Drive), and the prompt all differ. Folding both into `run-audit` would tangle the working initial path; a focused `rerun-audit` reuses `_shared` helpers (`ingest-file`, `claude-client`, `claude-parse`, `job-run`, scoped-db) and keeps `run-audit` pure.
- **File-level impact**:
  - **NEW** `supabase/functions/rerun-audit/index.ts` — async (202 ack + background), per-engagement key auth + scoped DB.
  - **NEW** `supabase/prompts/audit_remediation.md` — ported from the V2 Make.com remediation module, V3 placeholders.
  - **NEW migration** `0010_audit_runs_rerun.sql` — `audit_runs.run_type` / `auditor_notes` / `previous_audit_run_id`.
  - **NEW** `airtable/per-control-rerun-script.js` — reference re-run automation script.
  - **UPDATE** `supabase/functions/_shared/claude-parse.ts` (register `Incomplete Assessment`), `supabase/config.toml` (`[functions.rerun-audit] verify_jwt = false`).
- **Considered**: (a) re-judge the full evidence set on every re-run (rejected — re-pulls Drive, re-pays Opus to re-derive a known conclusion, no notion of "remediation"); (b) DB-level link reconciliation to handle replaced files (deferred — the notes-steered model handles supersession; reconciliation is kept as an optional future fix for the Drive `Run V3` path); (c) a `mode` branch inside `run-audit` (rejected — see above).
- **Revisit if**: auditors want a re-run that *does* re-pull Drive (then add a third `Re-run Audit 🤖` option that routes to `sync-control-evidence`); or a visible per-file evidence list / attachment merge on re-run is wanted; or the remediation rule hierarchy needs its own root-cause enum validation.

## ADR-014: Fan-out throttle — cap DB connections + a paced `pace-controls` coordinator

- **Date**: 2026-06-29
- **Status**: **BUILT — needs deploy + Batch Test 02.** Triggered by Batch Test 01 (`docs/BATCH_TEST_01.md`): a 55-document engagement run completed only 22/55.
- **Context**: An engagement run ticks **every** control at once. Each control's evidence-ingest (`sync-control-evidence`, `EVIDENCE_CONCURRENCY=5`) opens several Postgres connections, and `_shared/scoped-db.ts` pooled with the library default (`max:10`) **per edge isolate**. With ~15–20 controls firing together (plus `run-audit` and self-chained syncs), 100+ connections hit the Supabase transaction pooler (size ~50–70) → "no more connections allowed". That single failure cascaded into five different-looking symptoms (Evidence-Ready-but-no-audit, Partial-Evidence freezes, register errors, failed uploads, empty fields) — see Batch Test 01 for the symptom→cause mapping.
- **Decision**: three layered levers, smallest blast radius first.
  1. **Cap the pool per isolate** (`scoped-db.ts`): `max:5` (env `SCOPED_DB_POOL_MAX`) + `idle_timeout:20` + `max_lifetime:300` + `connect_timeout:15`. `max:5` matches the only real in-isolate concurrency (the 5 file workers) without serializing, while halving the per-isolate ceiling. Shared module → **all five client-data functions must be redeployed**.
  2. **Right-size the pooler** (infra): keep prod pool size ~50–70 so, at `max:5`/isolate, ~10–12 concurrent control isolates fit with headroom.
  3. **Throttle the fan-out** (`pace-controls` coordinator): the real root-cause fix. The Airtable tick script **cannot** throttle to completion — it's capped at ~30s and has no `setTimeout` (it busy-waits), so it can only spread the initial burst. The coordinator runs **server-side** (no 30s cap), launching controls in **waves** while keeping **in-flight connection-heavy jobs ≤ a cap** (`PACE_MAX_CONCURRENT`, default 8). It "launches" a control exactly as the tick script does — by setting **`Run V3 Audit`**, firing the unchanged per-control automation — so only the *pacing* moves server-side. It **self-chains** (re-invokes itself within a wall-clock budget) to survive the edge background-task limit.
- **Gating signal**: the count of **running `sync-control-evidence` jobs** for the engagement (`job_runs`). Sync is the connection-heavy phase; `register`/`refine` are fast and `run-audit` is connection-light + long, so gating on sync best tracks connection pressure. `countInFlight` fails *safe* (assumes full on error) so a `job_runs` read failure can't cause over-launching.
- **Launched-marker**: a control is "already launched" iff its `Run V3 Audit` field is truthy. The per-control script does **not** clear it, so it's a stable marker within a run — no double-launch. **Prerequisite for re-running a whole engagement: clear the controls' `Run V3 Audit` fields first** (same idea as resetting `Run_All_V3_Audits`), or the coordinator sees nothing to launch.
- **File-level impact**:
  - **UPDATE** `supabase/functions/_shared/scoped-db.ts` — pool limits (lever 1).
  - **NEW** `supabase/functions/pace-controls/index.ts` — the coordinator (lever 3); `[functions.pace-controls] verify_jwt = false` in `config.toml`.
  - **NEW** `supabase/functions/_shared/airtable.ts` `listAirtableRecords()` — paginated read used by the coordinator.
  - **UPDATE** `airtable/tick-controls-script.js` — stopgap: connection-aware waves, skips already-ticked, budget-guarded, reports unpaced count.
  - **NEW** `airtable/tick-controls-via-coordinator.js` — thin trigger that calls `pace-controls` (the durable path; point the engagement automation here once deployed).
- **Considered**: (a) bigger pause / smaller batch in the Airtable tick script (rejected as the *complete* fix — the ~30s cap bounds total pacing to ~20s, far less than control runtimes; kept as the stopgap); (b) an in-function concurrency gate where each sync self-defers when over cap (rejected for now — risks self-chain thrash and backoff tuning; the coordinator centralizes the decision); (c) gating on all running scoped jobs incl. `run-audit` (rejected — audits are long + connection-light, would idle slots).
- **Revisit if**: the coordinator's long lifetime needs the async batch queue (ADR-006/007) instead of self-chaining; or the launched-marker should be job_runs-based (to drop the manual run-field reset); or per-control concurrency needs weighting by file count rather than a flat cap.

### ADR-014 addendum (2026-06-29): register-engagement upserts on the Airtable base id

- **Found while testing a second project.** Each project is its own **Airtable base** (a duplicate of the template), and every base's engagement is "the first row". `register-engagement` keyed the upsert on that row's **record id** (`airtable_base_id`, a misnomer — it holds the `rec…`, not the base `app…`). So registering a *new* project could match an *existing* engagement row and **UPDATE/override** it instead of creating a new one — and on the update path no per-engagement key is minted, so `supabase_key` came back blank.
- **Fix**: match on the Airtable **base id** (`airtable_base` = `app…`) first — the true unique key (one base = one engagement) — falling back to the legacy record-id key only when the base id doesn't match (so pre-backfill engagements still resolve; the update backfills `airtable_base`). Migration `0011` adds a partial unique index on `airtable_base`. The master script already sends `airtable_base: base.id`, so no Airtable change is needed.
- **Cleanup note**: the earlier override left a single mixed engagement row in prod. For a clean test, delete the affected engagement row(s) (or re-register each base — a new base now creates its own row + key), then re-run.

---

## ADR-015: Durable audit queue — replace the fire-and-forget sync → run-audit handoff

- **Date**: 2026-07-21
- **Status**: **BUILT — needs deploy (see NEXT_STEPS §7) + a live confirmation run.**
- **Context**: Batch Test 04 challenge #3: on 3 of ~110 controls, evidence ingested fine but the audit never started — the single fire-and-forget POST from `sync-control-evidence` to `run-audit` was lost, and NOTHING could see it: the sync job had *succeeded*, so there was no stuck `running` row for the watchman, no error in `job_runs`, and the 💬 sat on "starting the audit…" forever. Every safety net to date (pool caps, `pace-controls`, `sweep-stuck-jobs`) compensates for the same root gap: work-transfer lives in network packets, not in durable state.
- **Decision**: Make the handoff a **durable queue** on infrastructure we already run:
  1. **`audit_queue` table (migration 0015)** — a plain public-schema table, written on the service client exactly like `job_runs`. A partial unique index (one live row per control) collapses double-enqueues at the DB. RLS on, no policies — system table.
  2. **`claim_audit_jobs` RPC** — the one piece that must be SQL: reclaim expired leases, then claim a small batch with `FOR UPDATE SKIP LOCKED` (N workers can never collide), bumping `attempts` at claim time (a killed worker can't self-report, so the claim is the only countable moment).
  3. **`audit-worker` function** — SYSTEM function (shared secret, like `sweep-stuck-jobs`), poked every minute by pg_cron/pg_net (the delivery guarantee) and "kicked" by the enqueuer for latency. Claims 2–3 rows, runs them concurrently, marks done / retries with backoff (2m/4m/8m) / dead-letters after 3 attempts with a "press Re-run" 💬. An idempotency guard (completed `audit_runs` row since `enqueued_at`) means a crash after commit but before ack skips the re-run instead of paying Opus twice.
  4. **`_shared/audit-pipeline.ts`** — run-audit's pipeline extracted to a shared module. The worker **cannot** POST to `run-audit`: per-engagement keys are stored only as SHA-256 hashes, so a cron-woken worker has no plaintext to forward (the old chain only worked by forwarding the caller's inbound key). Importing the pipeline needs no key — the queue row carries the engagement id and every client-data query still runs under `withEngagementScope`, so RLS still bites. `run-audit`'s HTTP entry remains for manual/smoke-test calls, running the identical shared code, and job_runs rows keep `function_name='run-audit'` so monitoring queries are unchanged.
- **Also fixed en route**: run-audit's Airtable write-back had NO 429 retry (a local plain-`fetch` helper) while the retrying `_shared/airtable.ts` existed — the verdict, the most important write in the system, was the least protected. The pipeline now uses the shared helper.
- **Considered**: (a) just retry the POST (`fetchWithRetry`) — shipped as a stopgap for the remaining self-chain hops, but a retry that also fails, or an isolate killed before the trigger line, still drops the work; (b) **pgmq / Supabase Queues** — same semantics for less code, but it lives in its own schema (service client can't call it without exposing `pgmq_public` or new raw-SQL grant plumbing), while a public-schema table rides the proven `job_runs` posture, is visible in Studio, and keeps the retry/dead-letter logic unit-testable in the repo's pure-logic style (`queue-logic.ts` + `queue.test.ts`); (c) external queue (Inngest/Trigger.dev, ADR-006/007) — still the eventual answer at 20+ clients, but not needed to fix this failure class.
- **Failure modes now**: lost kick → cron picks up in ≤60s; worker killed mid-audit → lease lapses, job reclaims and retries; crash after audit committed → idempotency guard skips; 3 strikes → dead-letter + auditor 💬; enqueue itself fails (the one remaining single point) → loud ⚠️ 💬 on the control instead of a silent stall.
- **Revisit if**: Phase 2 (per-file ingest queue — deletes the sync self-chain, `SYNC_BUDGET_MS`, the settle-wait, and the per-file-timeout race) and Phase 3 (retire `pace-controls`; worker batch size becomes the one concurrency knob) per the scalability review; or queue volume/latency outgrows a cron-poked worker — then move the same job rows onto an external runner.
