# SOC 2 ClearCheck

An **AI assistant for auditors**. It reads a company's security evidence (PDFs, spreadsheets,
screenshots, documents), judges whether each security control is being followed, and writes up
the finding — a first-draft audit note the auditor reviews and signs off. It turns hours of
manual reading into minutes of review.

The auditor works entirely from a simple **Airtable** screen: tick a box to run a control,
watch the progress, and read the result — no code or technical steps needed.

## Where to start

| If you are… | Read this |
|---|---|
| **New to the project** | [HANDOVER.md](./HANDOVER.md) — the entry point, in plain English. |
| **An auditor / everyday user** | [docs/USER_GUIDE.md](./docs/USER_GUIDE.md) — how to use it, step by step. |
| **An engineer taking it over** | [docs/TECHNICAL_HANDOVER.md](./docs/TECHNICAL_HANDOVER.md) — stack, deploy, and maintenance. |

## How it works, in one line

An auditor ticks **Run V3 Audit** in Airtable → the system registers the control, pulls its
evidence from Google Drive and reads it with AI, judges whether the control is met and writes up
the finding → the verdict appears back in Airtable for review.

## Stack

| Service | Used for |
|---|---|
| **Supabase** | Postgres database, Edge Functions (Deno/TS), Storage (evidence), Vault (secrets) |
| **Anthropic Claude** | Reading evidence, judging conformity, writing the workpaper |
| **OpenAI** | Embeddings for evidence search |
| **Airtable** | The auditor-facing frontend (controls grid, buttons, result fields) |
| **Google Drive** | Source of the evidence files (one folder per control) |

## Repository layout

```
├── HANDOVER.md            start here
├── README / ARCHITECTURE / SECURITY / RUNBOOK / DECISIONS .md   references
├── docs/                  USER_GUIDE, TECHNICAL_HANDOVER
├── airtable/              scripts connecting the Airtable buttons to the backend
├── scripts/               helper tools (sync prompts, mint engagement keys)
└── supabase/
    ├── migrations/        database schema
    ├── prompts/           the AI prompts (YAML frontmatter + body)
    └── functions/         _shared/ modules + the edge functions
```

## Reference docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — design, flow, schema, isolation, scalability
- [RUNBOOK.md](./RUNBOOK.md) — operational guide for auditors and ops
- [SECURITY.md](./SECURITY.md) — secrets, auth, per-client isolation, audit trail
- [DECISIONS.md](./DECISIONS.md) — architecture decision records
