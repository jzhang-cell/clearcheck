-- Adversarial isolation proof for ADR-011 RLS enforcement.
-- Mirrors the EXACT mechanism shipped in migrations 0006 (Lock policy) and
-- 0007 (engagement_scoped role) on a minimal schema, then runs cross-engagement
-- read/write attacks AS the scoped role. pgvector is absent locally so we cannot
-- load the full 0001 schema; the lock mechanism (role + GUC + policy) is fully
-- exercised here, which is the security claim under test.

\set ON_ERROR_STOP off
\pset pager off

drop schema if exists proof cascade;
create schema proof;
set search_path = proof, public;

-- ── Minimal mirror of the real tables (only the isolation-relevant columns) ──
create table engagements (
  id uuid primary key default gen_random_uuid(),
  client_name text not null
);
create table controls (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  control_id text not null
);

-- Human-path helper from 0006; dormant for the machine path (returns nothing).
create or replace function user_engagement_ids() returns setof uuid
  language sql stable as $$ select null::uuid where false $$;

-- ── 0007: the non-bypass scoped role + grants ──
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'engagement_scoped') then
    create role engagement_scoped nologin;
  end if;
end $$;
grant usage on schema proof to engagement_scoped;
grant select, insert, update, delete on engagements, controls to engagement_scoped;
grant execute on function user_engagement_ids() to engagement_scoped;
grant engagement_scoped to current_user;

-- ── 0006: enable RLS + the identical isolation policy pattern ──
alter table engagements enable row level security;
alter table controls enable row level security;
create policy "engagements_isolation" on engagements for all
  using (
    id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or id in (select user_engagement_ids())
  )
  with check (
    id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or id in (select user_engagement_ids())
  );
create policy "controls_isolation" on controls for all
  using (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  )
  with check (
    engagement_id = nullif(current_setting('app.current_engagement_id', true), '')::uuid
    or engagement_id in (select user_engagement_ids())
  );

-- ── Seed two engagements as the owner (superuser bypasses RLS for setup) ──
insert into engagements (id, client_name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Engagement A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Engagement B');
insert into controls (id, engagement_id, control_id) values
  ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CC.A.01'),
  ('b2222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'CC.B.01');

\echo '════════ Acting AS engagement A (this is what withEngagementScope does) ════════'
begin;
select set_config('app.current_engagement_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
set local role engagement_scoped;

\echo '── TEST 1 (read scope): SELECT * FROM controls → must return ONLY A''s row ──'
select control_id, engagement_id from controls order by control_id;

\echo '── TEST 2 (targeted cross-read): SELECT B''s control by its id → must be 0 rows ──'
select count(*) as b_rows_visible_to_a from controls
  where id = 'b2222222-2222-2222-2222-222222222222';

\echo '── TEST 3 (cross-write UPDATE): UPDATE B''s control → must affect 0 rows ──'
update controls set control_id = 'HACKED' where id = 'b2222222-2222-2222-2222-222222222222';
\echo '(UPDATE 0 above = blocked)'

\echo '── TEST 4 (cross-write INSERT): INSERT a row stamped for B → must RAISE (with check) ──'
-- Savepoint so the expected error does not poison the rest of the script.
-- (In production each withEngagementScope is its own transaction, so a blocked
-- write aborts only that scope — this savepoint reproduces that boundary.)
savepoint attempt_b;
insert into controls (engagement_id, control_id)
  values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'SMUGGLED');
rollback to savepoint attempt_b;
\echo '(if you see "new row violates row-level security policy" above = blocked)'

\echo '── TEST 5 (own-write sanity): INSERT a row for A → must SUCCEED ──'
insert into controls (engagement_id, control_id)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CC.A.02');
\echo '(INSERT 0 1 above = allowed)'

commit;

\echo '════════ Verify B''s data was untouched (back as owner, RLS bypassed) ════════'
\echo '── TEST 6: B''s control still CC.B.01, no SMUGGLED/HACKED rows anywhere ──'
select engagement_id, control_id from controls order by engagement_id, control_id;

drop schema proof cascade;
drop role if exists engagement_scoped;
