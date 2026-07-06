-- ═══════════════════════════════════════════════════════════════════
-- ClearCheck V3 — Per-engagement API keys (ADR-011, half 2)
-- Migration: 0008_engagement_api_keys.sql
--
-- Replaces the single shared AUDIT_SHARED_SECRET (whole-platform blast radius)
-- with one secret per engagement. The INBOUND key maps to exactly one
-- engagement, so a single header both (a) authenticates the caller and
-- (b) identifies which engagement to stamp for RLS (the Stamp the 0006
-- policies need). One leaked key burns one client, not all.
--
-- We store only a SHA-256 HASH of the key, never the plaintext. The plaintext
-- is generated + returned exactly ONCE by register-engagement (on create) and
-- saved by Airtable; it can never be recovered from the DB. Hashing is done in
-- the edge function (Web Crypto) so the plaintext never reaches Postgres / its
-- logs — this column just holds the hex digest.
--
-- SAFE: adds two nullable columns + an index. No existing behavior changes;
-- nothing reads these until auth.resolveEngagementByKey() is wired in.
-- Existing engagements have NULL api_key_hash until backfilled
-- (scripts/mint-engagement-key.ts) — they keep working on the shared secret
-- during the transition.
-- ═══════════════════════════════════════════════════════════════════

alter table engagements
  add column if not exists api_key_hash text,
  add column if not exists api_key_set_at timestamptz;

-- One key → one engagement. Unique so a hash can't collide across rows and so
-- the key→engagement lookup is a fast, unambiguous index probe.
create unique index if not exists engagements_api_key_hash_key
  on engagements (api_key_hash)
  where api_key_hash is not null;

comment on column engagements.api_key_hash is
  'SHA-256 hex of this engagement''s API key. Set once on create by '
  'register-engagement; plaintext is returned to Airtable once and never stored. '
  'NULL = not yet issued (falls back to AUDIT_SHARED_SECRET during transition).';
