# ClearCheck — Security Handover

This is an honest summary of the production security model and the controls the
incoming owner must maintain. It is not a certification or substitute for a
formal security review.

## Data classification

ClearCheck processes client audit evidence, control descriptions, audit notes,
and AI-generated conclusions. Treat all engagement content as confidential
client data.

Do not use production evidence in local development unless the engagement owner
has explicitly approved it and the local environment meets the same handling
requirements.

## Tenant isolation

Engagement-scoped functions use:

1. a unique per-engagement API key;
2. key-to-engagement resolution;
3. a transaction-local `app.current_engagement_id` database setting;
4. the non-bypass `engagement_scoped` database role; and
5. row-level security policies on client-data tables.

This model was adversarially tested in production: one engagement's key could
not read a control owned by another engagement.

System tables and system-wide workers use service-level access and therefore
require stricter entry-point and secret controls.

## Authentication boundaries

| Caller | Credential |
|---|---|
| Airtable engagement registration | `AUDIT_SHARED_SECRET` |
| Airtable per-control operations | Per-engagement API key |
| Scheduled cron and `audit-worker` | `AUDIT_SHARED_SECRET` |
| ClearCheck to Make.com | `MAKE_WEBHOOK_SECRET` |
| Make.com callback to ClearCheck | `MAKE_WEBHOOK_SECRET` |

Edge Functions use `verify_jwt = false`; authentication occurs in each handler.
The current pilot does not provide per-user identity or attribution for
Airtable callers.

## Secret inventory

Secret values belong in Supabase function secrets or an approved password
manager, never in Git.

| Name | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API |
| `OPENAI_API_KEY` | Embeddings |
| `AIRTABLE_PAT` | Airtable reads and writes |
| `AUDIT_SHARED_SECRET` | System entry points |
| `SUPABASE_DB_URL` | Scoped direct-Postgres connection |
| `GOOGLE_SA_JSON` | Google service-account credential |
| `GOOGLE_DRIVE_SUBJECT` | Delegated Google Workspace user |
| `MAKE_LARGE_PDF_WEBHOOK_URL` | Make.com scenario endpoint |
| `MAKE_WEBHOOK_SECRET` | Make request/callback authentication |

Supabase injects its own URL and service credentials into Edge Functions.

### Cron rotation trap

The sweeper's database cron reads `audit_shared_secret` from database Vault.
Edge Functions read `AUDIT_SHARED_SECRET` from function secrets. These are
separate copies.

Whenever the system secret is rotated:

1. update the Edge Function secret;
2. update the database Vault copy;
3. verify the next cron response is HTTP 200;
4. verify Airtable registration; and
5. record the rotation.

## External-service access

### Google Drive

- Use read-only Drive scope.
- Restrict delegated access to the approved Workspace subject.
- Review domain-wide delegation periodically.
- Rotate the service-account credential after suspected exposure.

### Airtable

- Give the PAT only the scopes and bases required for ClearCheck.
- Restrict automation editing to approved owners.
- Treat automation input variables containing keys as secrets.

### Make.com

- Require the shared Make secret on inbound and callback requests.
- Restrict scenario and connection access.
- Do not place Supabase service credentials in Make.
- Use only scoped file URLs supplied by ClearCheck.
- Review execution history because it can contain extracted client content.

### AI providers

- Use organization-controlled API accounts.
- Enable billing and usage alerts.
- Review provider data-retention and training settings under the applicable
  contract.
- Do not send more evidence than the workflow requires.

## Storage and evidence links

Evidence is stored in a private Supabase bucket. Airtable and Make.com receive
scoped, time-limited file URLs when required. URLs must not be copied into
long-lived public documents or tickets.

Hashes and source identifiers support deduplication. A filename alone is not a
security or identity boundary.

## Audit trail

- `job_runs` records operational function activity.
- `evidence_sync_runs` records initial evidence-sync lifecycle.
- `external_extraction_jobs` records Make.com status and execution references.
- `audit_queue` records durable handoff and retries.
- `audit_runs` records each initial or remediation audit.
- `audit_results` records the structured conclusion and workpaper.

Limit access to scratchpads, extracted evidence, and error payloads; they may
contain sensitive client information.

## Access-review checklist

Review at handover and at least quarterly:

- [ ] GitHub organization/repository administrators
- [ ] Supabase project members
- [ ] Airtable base owners and automation editors
- [ ] Anthropic/OpenAI organization members and API keys
- [ ] Google service accounts and domain-wide delegation
- [ ] Make.com organization, scenario, connection, and webhook access
- [ ] Password-manager vault membership
- [ ] Billing contacts and alert recipients
- [ ] Dormant or shared accounts

## Incident-response minimum

For suspected credential exposure:

1. identify the affected credential and blast radius;
2. disable or rotate it;
3. update every required copy;
4. review access and execution logs;
5. determine which engagements and evidence were exposed;
6. follow contractual notification requirements;
7. test the repaired workflow; and
8. document root cause and prevention.

For suspected cross-engagement access, stop affected processing immediately and
preserve logs before changing data.

## Known gaps

- No per-user identity or authorization for Airtable callers.
- No customer-facing rate limiter.
- No automated cost-spike anomaly response.
- No DLP or malware scan before evidence enters Storage.
- External providers process evidence under their own service controls.
- Airtable and Make.com may retain execution inputs/outputs according to their
  configured plans and policies.
- AI output is probabilistic and requires human review.
- The synchronized handover branch still requires review and acceptance before
  it becomes the client-controlled release source.

The incoming owner should assess these gaps against client contracts, privacy
requirements, and the organization's risk appetite before expanding use.
