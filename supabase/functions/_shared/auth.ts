// Auth for system-to-system callers (Airtable webhooks, cron, etc). We run with
// verify_jwt=false (see config.toml), so these helpers stand in for JWT checks.
//
// Two auth modes (ADR-011):
//   1. checkSharedSecret  — the single AUDIT_SHARED_SECRET. Used by SYSTEM/setup
//      functions that aren't tied to one engagement (e.g. register-engagement,
//      which mints a brand-new engagement before any per-engagement key exists).
//   2. resolveEngagementByKey — the per-engagement key. The inbound header maps
//      to exactly one engagement, so it both authenticates the caller AND tells
//      us which engagement to stamp for RLS. Used by per-engagement functions.

import { getServiceClient } from "./supabase-client.ts";
import { hashApiKey } from "./engagement-key.ts";

// Usage at the top of every Deno.serve handler:
//   const authErr = checkSharedSecret(req);
//   if (authErr) return authErr;
//
// 500 if the env var is missing (server misconfig). 401 if header missing or wrong.
export function checkSharedSecret(req: Request): Response | null {
  const expected = Deno.env.get("AUDIT_SHARED_SECRET");
  if (!expected) {
    return new Response(
      JSON.stringify({ error: "Server misconfiguration: AUDIT_SHARED_SECRET not set" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  const provided = req.headers.get("x-audit-secret");
  if (provided !== expected) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  return null;
}

// Resolve the inbound per-engagement key (x-audit-secret) to its engagement.
// Returns { engagementId } on success, or { error } with a ready-to-return
// Response (401 if the key is missing/unknown) — the lookup itself runs on the
// service client (system read of the engagements key column, not client data).
//
// Per-engagement keys map to exactly one engagement, so a hit uniquely
// identifies the caller's engagement. The plaintext is never stored; we hash
// the inbound key the same way register-engagement did at mint time and match
// on the hash.
export async function resolveEngagementByKey(
  req: Request,
): Promise<{ engagementId: string } | { error: Response }> {
  const provided = req.headers.get("x-audit-secret");
  const unauthorized = () => ({
    error: new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    ),
  });
  if (!provided) return unauthorized();

  const keyHash = await hashApiKey(provided);
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("engagements")
    .select("id")
    .eq("api_key_hash", keyHash)
    .maybeSingle();
  if (error) {
    return {
      error: new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    };
  }
  if (!data) return unauthorized(); // no engagement owns this key
  return { engagementId: data.id as string };
}
