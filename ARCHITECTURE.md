# ClearCheck — Architecture

This document describes the live production design. See
[docs/TECHNICAL_HANDOVER.md](docs/TECHNICAL_HANDOVER.md) for operations and
deployment.

> The handover review branch was synchronized from production source commit
> `052c55d`. Complete PR review and handover acceptance before deploying from
> the client repository.

## Design goals

- Keep the auditor workflow in Airtable.
- Isolate every engagement at the database boundary.
- Acknowledge Airtable quickly and perform slow work asynchronously.
- Store durable workflow state outside individual Edge Function invocations.
- Keep evidence identity, storage, and audit decisions in Supabase.
- Use external processing only where platform limits require it.
- Make failures observable and recoverable without claiming false completion.

## Context

```text
Auditor
  │
  ▼
Airtable ───────────────► Supabase Edge Functions
                              │
                              ├─► Postgres + pgvector
                              ├─► Private Storage
                              ├─► Anthropic Claude
                              ├─► OpenAI embeddings
                              ├─► Google Drive
                              └─► Make.com (large PDFs)
                                      │
                                      └─► callback to Supabase
```

Airtable is the interaction surface. Supabase is the system of record for
workflow and audit state.

## Initial-control flow

```text
register-control
      │
refine-control
      │
sync-control-evidence
      │
      ├─ V3_Evidence attachments, when non-empty
      └─ Google Drive folder, otherwise
      │
      ├─ ordinary extraction in Supabase
      └─ large PDF → Make.com → make-extraction-callback
      │
audit_queue
      │
audit-worker
      │
shared audit pipeline
      │
audit_runs + audit_results + Airtable write-back
```

### Why the queue matters

Evidence sync can finish near an Edge Function time limit. A fire-and-forget
HTTP call could be lost if the worker is terminated. The `audit_queue` row is a
durable handoff: once it exists, the audit worker can claim or retry it even
after the sync invocation ends.

### Why Make.com is limited to extraction

Large PDFs can exceed convenient Edge Function processing limits. Make.com
extracts and aggregates them, then returns one structured result. Supabase still
owns:

- file hashing and deduplication;
- private Storage;
- embeddings;
- evidence and control links;
- sync completion;
- audit queueing; and
- Airtable mirroring.

This keeps one source of truth and prevents external scenarios from bypassing
workflow invariants.

## Re-run architecture

The plain **Run** option starts another full evidence sync. Additional Evidence
and Additional Notes use `rerun-audit`, which evaluates the prior conclusion
against only the new material. Each remediation creates a new `audit_runs` row
linked to the prior run.

## Engagement-wide pacing

`pace-controls` launches controls in waves under a configured global cap. It
fair-shares capacity across active engagements and watches connection-heavy
evidence-sync work. It self-chains within an execution budget until every
control is launched.

This avoids using Airtable's short automation runtime as a batch scheduler and
protects the Supabase connection pool.

## Recovery architecture

### Audit worker

Queue rows move through:

```text
pending → processing → done
                  └──→ pending (retry)
                  └──→ dead
```

Leases allow a new worker to reclaim work after a terminated invocation.

### Evidence sync

`evidence_sync_runs` provides one durable lifecycle for initial evidence
collection. Large-PDF sub-jobs live in `external_extraction_jobs`.

### Scheduled watchman

`sweep-stuck-jobs` runs every five minutes:

- closes impossible old `running` job rows;
- closes external extraction jobs after a conservative stale cutoff;
- supports selected-control recovery from Airtable; and
- verifies the exact restarted sync, audit, worker result, and Airtable
  write-back before reporting full recovery.

## Function inventory

| Function | Category |
|---|---|
| `register-engagement` | Setup |
| `register-control` | Setup |
| `refine-control` | AI refinement |
| `sync-control-evidence` | Evidence orchestration |
| `make-extraction-callback` | External continuation |
| `audit-worker` | Durable queue consumer |
| `run-audit` | Audit entry point |
| `rerun-audit` | Remediation |
| `pace-controls` | Batch coordination |
| `sweep-stuck-jobs` | Cleanup and recovery |

## Data model

| Domain | Tables |
|---|---|
| Reference | `tscs`, `prompts` |
| Engagement | `engagements`, `engagement_users` |
| Controls | `controls`, `control_tscs`, `sample_tests` |
| Evidence | `evidence_files`, `evidence_control_links`, `extracted_evidence` |
| Audit | `audit_runs`, `audit_results` |
| Operations | `job_runs`, `audit_queue`, `evidence_sync_runs`, `external_extraction_jobs` |

Private evidence objects use engagement/control-scoped Storage paths. Signed
URLs are short-lived and generated only when required for controlled download
or Airtable attachment display.

## Isolation model

1. A per-engagement API key authenticates an engagement-scoped request.
2. The request resolves one engagement ID.
3. A direct Postgres transaction stamps
   `app.current_engagement_id`.
4. The transaction assumes the non-bypass `engagement_scoped` role.
5. RLS policies restrict client tables to that engagement.

System tables and system-wide workers use service-level access. Their entry
points use separate system secrets and narrowly defined payloads.

## Reliability boundaries

| Boundary | Mechanism |
|---|---|
| Airtable's short automation runtime | Fast acknowledgements and background work |
| Edge Function termination | Durable sync/queue rows and leases |
| Duplicate triggers/callbacks | Hash dedupe, live-row constraints, idempotent callback |
| Provider/network failures | Timeouts, bounded retry, actionable terminal status |
| Large PDF duration | External Make.com processing |
| Batch connection pressure | Global pacing and fair sharing |
| Lost progress | `job_runs`, lifecycle tables, and scheduled sweeping |

## AI responsibilities

- Claude Haiku-class models: control refinement and high-volume extraction.
- Claude higher-reasoning model: audit judgment.
- Claude rendering model: workpaper drafting.
- OpenAI: evidence embeddings.

Model names and limits belong to versioned prompt rows, not architectural
assumptions. Human review remains the final quality gate.

## Intentional limitations

- Airtable remains the frontend and requires separately published automation
  scripts.
- Prompts require a separate database activation step.
- Current engagement keys identify a client, not an individual user.
- Make.com handles initial-sync large PDFs, not remediation attachments.
- The system has no automated cost-anomaly response or customer-facing rate
  limiter.

Historical rationale is recorded in [DECISIONS.md](DECISIONS.md). Some early
ADRs describe superseded implementation stages; later updates and this document
represent the current design.
