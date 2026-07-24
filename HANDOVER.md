# ClearCheck — Client Handover

This document is the entry point for taking ownership of ClearCheck. It explains
what the system does, what is live, where the operational responsibilities sit,
and what must be confirmed before the handover is complete.

ClearCheck supports an auditor's review; it does not replace professional
judgment or final sign-off.

## Handover status

| Area | Status | Required action |
|---|---|---|
| Production service | Live in Supabase project `kwuymtlpjkziqkumixvk` | Confirm the incoming technical owner has dashboard access. |
| Auditor workflow | Live in Airtable | Confirm the production automations match the reference scripts. |
| Evidence sources | Airtable attachments first, Google Drive as fallback | Confirm both sources with a test control. |
| Large PDFs | Offloaded to Make.com when configured | Confirm the Make scenario, connection owner, and callback secret. |
| This repository | Production source synchronized on `codex/refine-handover-notes` from production commit `052c55d` | Review and merge the draft PR, then record the accepted client-repository commit. |
| Ownership transfer | Pending acceptance | Complete the checklist at the end of this document. |

> **Important:** the production source has been synchronized onto the handover
> review branch, including the durable audit worker, Make.com large-PDF
> callback, external extraction tables, Airtable-first evidence selection, and
> enhanced sweep verification. Do not deploy it until the draft PR is reviewed,
> merged, and tagged as the accepted handover release.

## What ClearCheck does

ClearCheck is an AI-assisted SOC 2 evidence-review pipeline. For each control it:

1. receives the control and its expected audit procedures from Airtable;
2. refines the wording of the control and procedures;
3. collects evidence from Airtable or Google Drive;
4. extracts and indexes the relevant content;
5. prepares a suggested conformity conclusion and workpaper; and
6. writes the status, conclusion, evidence, and workpaper back to Airtable.

The auditor reviews the evidence and generated workpaper and remains responsible
for the final conclusion.

## Where to start

| Audience | Start here |
|---|---|
| Auditor or engagement manager | [User Guide](docs/USER_GUIDE.md) |
| Technical owner | [Technical Handover](docs/TECHNICAL_HANDOVER.md) |
| Operations/support | [Runbook](RUNBOOK.md) |
| Security reviewer | [Security](SECURITY.md) |
| Developer | [Architecture](ARCHITECTURE.md) and [Decision Records](DECISIONS.md) |

## Production flow

```text
Airtable: Run V3 Audit
        │
        ├─ register and refine the control
        │
        ├─ select evidence
        │    ├─ use V3_Evidence attachments when present
        │    └─ otherwise use the control's Google Drive folder
        │
        ├─ extract evidence
        │    ├─ ordinary files: Supabase/Claude
        │    └─ large PDFs: Make.com, then callback to Supabase
        │
        ├─ enqueue the audit in Supabase
        │
        ├─ judge the evidence and render the workpaper
        │
        └─ write the final result to Airtable
```

Long-running work is asynchronous. Airtable receives a quick acknowledgement,
while Supabase continues the work and updates `ClearCheck 💬` as each stage
finishes.

## System boundaries

| Service | Responsibility |
|---|---|
| Airtable | Auditor interface, automation triggers, evidence attachments, results |
| Supabase | Database, private file storage, functions, durable queues, cron, secrets |
| Anthropic Claude | Evidence extraction, control refinement, audit judgment, workpaper drafting |
| OpenAI | Evidence embeddings used for search and retrieval |
| Google Drive | Default evidence source when `V3_Evidence` is empty |
| Make.com | External processing for large PDFs only |
| GitHub | Version-controlled source, prompts, scripts, migrations, and documentation |

## What the incoming owner must receive

Access should be transferred through the relevant service's user-management
features, not by sharing personal passwords.

- GitHub repository access
- Supabase production-project access
- Airtable base and automation access
- Anthropic and OpenAI account/billing access
- Google Workspace and service-account administration
- Make.com organization, scenario, connection, and execution-history access
- the approved password-manager vault containing operational secrets
- billing ownership and alert contacts for every paid service

## Responsibilities to assign

Do not complete the handover until each role has a named owner.

| Responsibility | Owner |
|---|---|
| Final audit judgment and workpaper approval | _Assign_ |
| Airtable schema and automations | _Assign_ |
| Supabase database, functions, cron, and incident response | _Assign_ |
| AI provider billing, rate limits, and model changes | _Assign_ |
| Google Drive permissions and service account | _Assign_ |
| Make.com large-PDF scenario | _Assign_ |
| Secrets rotation and access reviews | _Assign_ |
| GitHub releases and production deployments | _Assign_ |

## Known operational constraints

- AI output can vary and must be reviewed by an auditor.
- Airtable automation scripts are copied into Airtable; editing a repository
  file does not update the live automation automatically.
- Prompt files are loaded into the Supabase `prompts` table; editing Markdown
  alone does not change production.
- Initial large-PDF extraction can use Make.com. Additional-evidence remediation
  currently uses the local extraction path.
- A lost Make callback can leave a sync waiting until the scheduled watchman
  closes it and reports a retry message.
- Per-engagement API keys isolate clients, but the current pilot does not
  identify individual Airtable users.

## Handover acceptance checklist

### Access and ownership

- [ ] Every service in “What the incoming owner must receive” has at least two
      authorized administrators.
- [ ] Billing ownership and rate-limit alerts have been transferred.
- [ ] Shared or development-era credentials have been rotated.
- [ ] The incoming owner knows where the approved password-manager vault lives.

### Source and configuration

- [ ] The synchronized production-source PR has been reviewed and merged.
- [ ] The default branch and production release/commit have been recorded.
- [ ] Airtable's live scripts have been compared with `airtable/`.
- [ ] Active Supabase prompts have been compared with `supabase/prompts/`.
- [ ] Supabase migrations and deployed function versions match the release.
- [ ] The Make.com scenario and callback contract match the source documentation.

### Operational proof

- [ ] Run one small-PDF control from start to finish.
- [ ] Run one PDF over 50 pages and confirm the Make callback completes.
- [ ] Run one control using non-empty `V3_Evidence` and confirm Drive is skipped.
- [ ] Perform an additional-evidence or additional-notes remediation.
- [ ] Confirm the final Airtable workpaper and status fields are populated.
- [ ] Confirm cron cleanup and bad-control sweep recovery are healthy.
- [ ] Confirm the incoming owner can find a failed job and its cause.

### Final acceptance

- [ ] Known limitations and open risks have been reviewed and accepted.
- [ ] Incident contacts and response expectations have been agreed.
- [ ] A handover date and outgoing-support end date have been recorded.
- [ ] The incoming technical and audit owners have signed off.
