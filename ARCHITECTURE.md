# ClearCheck V3 — Architecture

> Technical design and trade-offs. Read alongside [DECISIONS.md](./DECISIONS.md) for the "why".

## V2 → V3

| | V2 | V3 |
|---|---|---|
| Orchestration | Make.com scenarios | Supabase Edge Functions (Deno/TS) |
| Latency | multi-hop webhooks | direct function → Claude |
| Observability | Make run history | every call in `job_runs` (tokens, cost, errors) |
| Cost/control | per-operation Make pricing | own infra, tiered Claude models |
| Frontend | Airtable | Airtable (unchanged for auditors) |

## V3 internal flow

```
Auditor ticks "Run V3 Audit" (Airtable)
  → Airtable Automation: refine-control → run-audit  (fire-and-forget POST + x-audit-secret)
    → [auth boundary: checkSharedSecret]
    → run-audit: load control + engagement + linked evidence
    → Claude Opus  → conformity verdict
    → Claude Sonnet (temp 0) → workpaper markdown
    → write audit_runs / audit_results (Supabase)
    → PATCH V3_* fields back to the Airtable row
  → auditor refreshes, sees the verdict ~30–60s later
```

## Edge Functions (5)

| Function | Trigger | Does | Models | Logs |
|---|---|---|---|---|
| `register-engagement` | Airtable master script | upsert engagement, mint per-engagement key, store Airtable base id | — | job_runs |
| `register-control` | Airtable per-control | upsert control + link TSCs; returns `control_uuid` | — | job_runs |
| `refine-control` | Airtable per-control | polish control description + expected procedure; write `V3_Refined_*` back | Haiku | job_runs |
| `sync-control-evidence` | Airtable per-control | pull Drive folder → Storage → ingest (concurrent, async), then trigger run-audit | Haiku + OpenAI | job_runs |
| `run-audit` | chained by sync | synthesis → judgment → workpaper → DB + Airtable write-back (async) | Opus + Sonnet | job_runs |

Auth (ADR-011): `register-engagement` uses the shared `AUDIT_SHARED_SECRET`; the other four use a **per-engagement key** + `withEngagementScope()`. All: `verify_jwt=false`, `startJobRun`/`completeJobRun`/`failJobRun`. *(The old single-file `ingest-evidence` / `ingest-evidence-batch` were retired 2026-06-27 — ingestion now lives inside `sync-control-evidence`.)*

**Engagement resolution (run-audit):** the control_id from the request loads the `controls` row, which carries `engagement_id` (→ stamps `audit_runs`, resolves the Airtable base) and `airtable_record_id` (→ the exact Airtable row). See [run-audit/index.ts:84](supabase/functions/run-audit/index.ts#L84), [:308](supabase/functions/run-audit/index.ts#L308), [:338](supabase/functions/run-audit/index.ts#L338), [:521-523](supabase/functions/run-audit/index.ts#L521-L523).

## Database schema (13 tables + RLS)

| Domain | Tables |
|---|---|
| Reference | `tscs`, `prompts` |
| Engagement | `engagements` (incl. `google_drive_id`, `evidence_folder_id`), `engagement_users` |
| Domain | `controls`, `control_tscs`, `sample_tests` |
| Pipeline | `evidence_files`, `evidence_control_links`, `extracted_evidence` |
| Audit | `audit_runs`, `audit_results` |
| Ops | `job_runs` |

Extensions: `pgvector`, `pgcrypto`. Storage bucket: `evidence`. Every client-data table carries `engagement_id` (child tables labeled in `0005`) and has an `<table>_isolation` RLS policy (`0006`). A non-bypass `engagement_scoped` role (`0007`) is the identity those policies apply to — see the RLS section below.

## Migrations

| | What |
|---|---|
| `0001` | initial schema (13 tables, pgvector, pgcrypto, RLS enabled) |
| `0002` | `job_runs` parent/child for async batch |
| `0003` | `engagements.google_drive_id` + `evidence_folder_id` |
| `0004` | drop `audit_results.conformity_level` |
| `0005` | RLS **Label** — `engagement_id` on child tables + auto-fill triggers |
| `0006` | RLS **Lock** — `<table>_isolation` policies |
| `0007` | RLS **Restrict foundation** — `engagement_scoped` role |

## AI model tiering

- **Haiku** — extraction + refinement (cheap, high-volume).
- **Opus** — audit judgment (the hardest reasoning; quality gate).
- **Sonnet (temp 0)** — workpaper rendering (deterministic prose).

## Auth model

Today: `verify_jwt=false`; `register-engagement` authenticates with the shared `AUDIT_SHARED_SECRET`, and every per-control function authenticates with a **per-engagement key** that also drives RLS enforcement (ADR-011). Phase 2: per-user JWT. See [SECURITY.md](./SECURITY.md).

## RLS (multi-client isolation)

Mechanism: an RLS policy on each client table filters every query to `engagement_id = current_setting('app.current_engagement_id')`. The function sets that "badge" per request (**Stamp**) and connects as the non-bypass `engagement_scoped` role (**Restrict**), so the lock actually applies.

**Status:** **LIVE end-to-end and adversarially proven.** Label + Lock + scoped role are shipped, and every client-data operation runs as `engagement_scoped` with the badge stamped per request via `withEngagementScope()` — one engagement's key cannot see another engagement's rows (proof harness: `supabase/tests/rls_isolation_proof.sql`). System tables (`prompts`, `job_runs`) intentionally remain on `service_role`. See [DECISIONS.md](./DECISIONS.md) ADR-008/ADR-011.

## Storage + Vault

Files: `evidence/{slug}/{control_id}/{filename}`; 24h signed URLs minted for Airtable attachments. Secrets in Vault, read via `Deno.env`; local mirror in gitignored `.env`.

## Scalability (3 tiers)

- **Prototype** — free tier, ~150s worker ceiling, client-side per-file orchestration for batches.
- **Pilot (now)** — Supabase Pro, longer worker budget, in-platform coordinator + per-file fanout.
- **Scale** — external durable queue (Inngest/Trigger.dev) for fanout, retries, per-tenant isolation at 20+ clients/month.

## Known limitations

- **30s Airtable script timeout** → fire-and-forget pattern (202 ack + background work).
- **Engagement-wide runs are throughput-bounded by the DB connection pool** → the `pace-controls` coordinator launches controls in waves under a global cap, fair-shared across concurrently running engagements (ADR-014).
- **~150s worker wall-clock** → long work self-chains into fresh invocations.
- **`sb_publishable_*` aren't JWTs** → key-based auth instead.

## Phase 2 backlog

Per-user JWT auth · timing-safe secret compare + Vault rotation runbook · `temperature` column on `prompts` · external durable queue (Inngest/Trigger.dev) for fanout/retries at multi-client scale.
