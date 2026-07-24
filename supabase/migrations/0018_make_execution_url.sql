-- Store a direct Make.com execution link on each external extraction job so an
-- operator can jump from Supabase diagnostics to the matching Make run.

alter table public.external_extraction_jobs
  add column if not exists provider_execution_url text;

comment on column public.external_extraction_jobs.provider_execution_url is
  'Direct provider execution URL supplied by Make in its callback for debugging.';
