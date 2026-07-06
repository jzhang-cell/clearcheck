-- ═══════════════════════════════════════════════════════════════════
-- ClearCheck V3 — engagements: Google Drive linkage
-- Migration: 0003_engagements_drive_columns.sql
--
-- Adds Google Drive references to engagements so evidence can be sourced
-- from / linked to a client's Drive folder.
--   google_drive_id    — the client's root Google Drive (drive/folder) id
--   evidence_folder_id — the specific Drive folder holding this engagement's evidence
-- Both nullable text; existing engagements remain valid.
-- ═══════════════════════════════════════════════════════════════════

alter table engagements
  add column if not exists google_drive_id text,
  add column if not exists evidence_folder_id text;
