# ClearCheck V3 — Security

> Honest security posture. Multi-engagement isolation is **LIVE and adversarially proven** (2026-06-27) for the per-control functions; the remaining gaps are the two legacy `ingest-evidence` functions (being retired) and the deferred Phase-2 items below.

## Secrets handling (Vault)

Four secrets, never hardcoded:

| Secret | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | Claude calls (all functions) |
| `OPENAI_API_KEY` | embeddings (ingest) |
| `AUDIT_SHARED_SECRET` | `x-audit-secret` header check (all functions) |
| `AIRTABLE_PAT` | Airtable write-backs |

- **Cloud:** Supabase Vault, read via `Deno.env`. Production uses a **fresh** `AUDIT_SHARED_SECRET` — NOT the prototype's.
- **Local:** `supabase/functions/.env` (gitignored).
- **Service-account key** for Google Drive lives in `tmp/clearcheck-drive-sa.json` (gitignored, never committed). Rotate after any exposure.

## Data isolation (engagement scoping + RLS)

The multi-client isolation work follows **Label → Lock → Stamp → Restrict**:

| Step | What | Status |
|---|---|---|
| **Label** | every client-data row carries `engagement_id` (migration `0005` added it to the 4 child tables + auto-fill triggers) | ✅ done |
| **Lock** | one `<table>_isolation` RLS policy per client table — a row is visible only if its `engagement_id` matches the connection's badge `app.current_engagement_id` (or the logged-in user's engagements). Migration `0006`. | ✅ done + adversarially proven |
| **Restrict foundation** | a non-bypass `engagement_scoped` role the locks apply to, granted only on client-data tables + `tscs`. Migration `0007`. | ✅ done + proven |
| **Stamp + Restrict (in functions)** | the per-control functions (`register-control`, `refine-control`, `sync-control-evidence`, `run-audit`) authenticate with a per-engagement key and run client-data ops through `withEngagementScope()` on the non-bypass `engagement_scoped` role | ✅ **LIVE + adversarially proven (2026-06-27)** |

**Status (2026-06-27): isolation is LIVE and adversarially proven in prod.** The per-control functions use per-engagement keys + `withEngagementScope()` (the non-bypass `engagement_scoped` role), so RLS filters every client-data query by `engagement_id`. **Verified live:** a control belonging to engagement B returns **HTTP 404** when called with engagement A's key, while B's own key gets past auth/scope (HTTP 400, not 404) — proving A cannot read B's data. `service_role` is now used only for system tables (prompts, job_runs, tscs). See [DECISIONS.md](./DECISIONS.md) ADR-008/011. **Last remaining `service_role` surface:** the two legacy `ingest-evidence` functions — being retired.

## Auth model (Phase 1 shared-secret)

- `verify_jwt = false` per function (`sb_publishable_*` keys aren't JWTs, so PostgREST JWT verification can't be used as-is).
- Each handler calls `checkSharedSecret(req)` — compares the `x-audit-secret` header against `AUDIT_SHARED_SECRET`. Currently a plain string compare (no timing-safe compare yet).
- No per-user identity in requests today — we can attribute an audit only to "someone with the secret."

## Audit trail

- **`job_runs`** — every function invocation: function name, status, payload, tokens/cost, `error_stack`.
- **`audit_runs`** — per-control audit lifecycle, including the `evidence_synthesis` snapshot and `engagement_id`.
- **`audit_results`** — the verdict, scratchpad reasoning, and rendered workpaper markdown.

To reconstruct a failed audit: find the `job_runs` row → its `audit_run_id` → the `audit_results` row.

## Known gaps (read before pointing real client data at the system)

- **RLS is enforced** in the per-control functions (per-engagement key + scoped role, adversarially proven 2026-06-27). The only remaining `service_role` surface is the two legacy `ingest-evidence` functions — being retired.
- **`verify_jwt = false`** — auth is the shared secret alone; no per-user identity.
- **Plain string secret compare** — no timing-safe compare (low risk at our volume, but auditors will flag it).
- No rate limiting, no cost-spike anomaly detection, no DLP scan on evidence before Storage, no encryption-at-rest beyond Postgres defaults.
- **Google Drive auto-pull** uses a service account; access is pending a Workspace Super Admin authorizing Domain-Wide Delegation (read-only `drive.readonly`). Until then the SA cannot read the Shared Drive.
