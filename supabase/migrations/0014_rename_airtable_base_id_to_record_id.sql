-- ════════════════════════════════════════════════════════════════════
-- Migration: 0014_rename_airtable_base_id_to_record_id.sql
-- ════════════════════════════════════════════════════════════════════
--
-- Renames engagements.airtable_base_id → engagements.airtable_record_id.
--
-- WHY: the column name `airtable_base_id` is a long-standing MISNOMER. Despite
-- its name it stores the engagement row's Airtable RECORD id (rec…), NOT the
-- Airtable BASE id (app…) — the base id lives in the separate `airtable_base`
-- column (added in 0009). The mismatched name caused real confusion (it reads
-- like the base id) and the request payload already calls this value
-- `airtable_record_id`, so the column now matches the payload field and its
-- sibling `airtable_base`. Pure rename: the data (rec… ids) is preserved.
--
-- Only consumer of the column is register-engagement (the legacy record-id
-- dedupe fallback + the insert), deployed alongside this migration.
--
-- Idempotent: only renames if the old column still exists.
-- ════════════════════════════════════════════════════════════════════

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'engagements'
      and column_name = 'airtable_base_id'
  ) then
    alter table public.engagements rename column airtable_base_id to airtable_record_id;
  end if;
end $$;

-- PostgREST caches the schema; tell it to reload so the renamed column is
-- visible to supabase-js queries immediately (register-engagement uses it).
notify pgrst, 'reload schema';
