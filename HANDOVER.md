# SOC 2 ClearCheck — Handover

Welcome. This is the starting point for the SOC 2 ClearCheck system. It's written in plain
English so anyone — technical or not — can understand what this is and where to look next.

---

## What is SOC 2 ClearCheck?

SOC 2 ClearCheck is an **AI assistant for auditors**. It reads a company's security evidence
(PDFs, spreadsheets, screenshots, documents), decides whether each security control is being
followed, and writes up its finding — like a first-draft audit note. The auditor reviews and
signs off. It turns hours of manual reading into a few minutes of review.

The auditor does everything from a simple **Airtable** screen: tick a box to run a control,
watch the progress, and read the result. No code or technical steps are needed to use it.

---

## Where to start (pick your guide)

| If you are… | Read this |
|---|---|
| **An auditor / everyday user** | [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — what it is and how to use it, step by step, in plain English. |
| **An engineer taking over the system** | [docs/TECHNICAL_HANDOVER.md](docs/TECHNICAL_HANDOVER.md) — the full technical picture: how it's built, how to deploy, and how to maintain it. |

---

## How it works, in one picture

```
  Auditor ticks "Run V3 Audit" in Airtable
                 │
                 ▼
  1. Register the control
  2. Tidy up its description
  3. Pull its evidence from Google Drive and READ it with AI
  4. JUDGE whether the control is met, and WRITE UP the finding
                 │
                 ▼
  The verdict + write-up appear back in Airtable for the auditor to review
```

Everything runs automatically in the background once the box is ticked.

---

## What's in this repository

| Folder / file | What it is |
|---|---|
| `supabase/` | The backend — the database, the functions that do the work, and the AI prompts. |
| `airtable/` | The small scripts that connect the Airtable buttons to the backend. |
| `scripts/` | Helper tools (e.g. syncing prompts, creating engagement keys). |
| `docs/` | Documentation, including the two guides above. |
| `ARCHITECTURE.md`, `SECURITY.md`, `RUNBOOK.md`, `DECISIONS.md` | Deeper technical and operational references. |

---

## The main things to know

- **The AI models used:** Claude (for reading evidence, judging, and writing) and OpenAI
  (for evidence search). API keys for both are required.
- **Where evidence comes from:** a Google Drive folder per control.
- **Where results appear:** the Airtable control row (status, rating, and the written note).
- **Each client is kept separate** and every action is logged, so the system is safe to run
  for many clients.

For anything deeper, the two guides above and the reference docs cover it.

---

## Release notes — v1.0 (July 2026)

- Full pipeline live in production: register → refine control → pull & read evidence
  (Google Drive) → AI audit judgment → write-up back in Airtable.
- Per-client isolation enforced at the database level (row-level security + a separate
  API key per engagement), with an adversarial test proving it.
- Engagement-wide runs are paced automatically to protect the database, with fair
  sharing between clients running at the same time.
- Transient network hiccups (Airtable rate limits, Drive blips) retry automatically;
  a watchdog detects stalled jobs and tells the auditor how to recover.
- A re-run (remediation) flow lets an auditor add evidence or notes after a first
  verdict and get an updated judgment at a fraction of the cost.

---

## Security note

All secrets (Claude / OpenAI / Airtable / Google keys) live in **Supabase Vault** and the
gitignored `supabase/functions/.env` — never in the code. If any keys were shared during
development, rotate them as part of taking the system over.
