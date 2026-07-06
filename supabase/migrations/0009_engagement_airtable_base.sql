-- ═══════════════════════════════════════════════════════════════════
-- ClearCheck V3 — Real Airtable base ID for write-back
-- Migration: 0009_engagement_airtable_base.sql
--
-- The existing `airtable_base_id` column is a MISNOMER: it stores the
-- engagement row's Airtable RECORD id (rec...), used as the upsert key in
-- register-engagement. It does NOT hold the Airtable base id (app...).
--
-- The write-back path (_shared/airtable.ts → patchAirtableRecord) needs the
-- real base id to build https://api.airtable.com/v0/{baseId}/{tableId}/{recordId}.
-- This adds a dedicated column for it so write-back can resolve the base per
-- engagement instead of skipping with skip_reason "no_base_id".
--
-- SAFE: adds one nullable column. Nothing reads it until write-back is wired
-- to it; existing engagements stay NULL until backfilled by the next
-- register-engagement call (the master script now sends airtable_base).
-- ═══════════════════════════════════════════════════════════════════

alter table engagements
  add column if not exists airtable_base text;

comment on column engagements.airtable_base is
  'Airtable base id (app...) this engagement lives in. Used by the write-back '
  'path to PATCH records. Distinct from airtable_base_id, which (despite its '
  'name) stores the engagement row''s Airtable RECORD id (rec...).';
