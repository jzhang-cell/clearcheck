-- Make extracted-evidence persistence concurrency-safe. Two controls can submit
-- byte-identical files at the same time; both workers then converge on the same
-- evidence_file row. Keep one extraction per file/prompt and let the loser reuse
-- it instead of creating duplicate extracted content.

with ranked as (
  select id,
         row_number() over (
           partition by evidence_file_id, extractor_prompt_id
           order by extracted_at, id
         ) as duplicate_rank
  from extracted_evidence
)
delete from extracted_evidence ee
using ranked r
where ee.id = r.id
  and r.duplicate_rank > 1;

create unique index if not exists extracted_evidence_file_prompt_unique
  on extracted_evidence(evidence_file_id, extractor_prompt_id);
