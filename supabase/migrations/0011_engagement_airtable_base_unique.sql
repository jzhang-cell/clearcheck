-- ═══════════════════════════════════════════════════════════════════
-- ClearCheck V3 — One engagement per Airtable base
-- Migration: 0011_engagement_airtable_base_unique.sql
-- ═══════════════════════════════════════════════════════════════════
--
-- register-engagement now upserts on the Airtable BASE id (app...) — one base =
-- one engagement in our model (each project is its own duplicated base). This
-- partial unique index enforces that invariant at the DB level and lets the
-- lookup's .maybeSingle() stay correct (it would error if two rows shared a base).
--
-- PARTIAL (WHERE airtable_base IS NOT NULL): legacy/seeded engagements that
-- predate the airtable_base backfill keep NULL and are excluded, so this can't
-- fail on them. If the index fails to create, it means two engagements already
-- share a base id (e.g. the earlier override bug) — resolve those duplicates
-- before re-applying.

create unique index if not exists engagements_airtable_base_uidx
  on engagements (airtable_base)
  where airtable_base is not null;

comment on index engagements_airtable_base_uidx is
  'One engagement per Airtable base (app...). register-engagement upserts on '
  'airtable_base; this guarantees the lookup resolves a single row.';
