// Mint (or rotate) a per-engagement API key for an EXISTING engagement row
// that predates register-engagement's auto-minting — i.e. the seeded prod
// engagement (ADR-011, half 2). New engagements get their key automatically on
// create; this is the one-off backfill / rotation path.
//
// Stores only the SHA-256 hash on engagements.api_key_hash (same hashing as the
// edge function, so the key verifies via auth.resolveEngagementByKey). Prints
// the plaintext ONCE — copy it into the engagement's sensitive Airtable field
// immediately; it cannot be recovered afterward.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... deno run \
//     --allow-env --allow-net \
//     scripts/mint-engagement-key.ts <engagement-uuid>
//
// Rotation: re-running issues a fresh key and overwrites the old hash (the old
// key stops working). Use deliberately.

import { createClient } from "npm:@supabase/supabase-js@^2";
import { generateApiKey, hashApiKey } from "../supabase/functions/_shared/engagement-key.ts";

const [engagementId] = Deno.args;
if (!engagementId) {
  console.error("Usage: scripts/mint-engagement-key.ts <engagement-uuid>");
  Deno.exit(1);
}

const url = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!key) {
  console.error("SUPABASE_SERVICE_ROLE_KEY env required");
  Deno.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: existing, error: lookupErr } = await supabase
  .from("engagements")
  .select("id, client_name, api_key_set_at")
  .eq("id", engagementId)
  .maybeSingle();
if (lookupErr) {
  console.error(`Lookup failed: ${lookupErr.message}`);
  Deno.exit(1);
}
if (!existing) {
  console.error(`No engagement with id ${engagementId}`);
  Deno.exit(1);
}
if (existing.api_key_set_at) {
  console.warn(
    `⚠  ${existing.client_name} already has a key (set ${existing.api_key_set_at}). ` +
      `Re-minting ROTATES it — the old key will stop working.`,
  );
}

const apiKey = generateApiKey();
const apiKeyHash = await hashApiKey(apiKey);

const { error: updateErr } = await supabase
  .from("engagements")
  .update({ api_key_hash: apiKeyHash, api_key_set_at: new Date().toISOString() })
  .eq("id", engagementId);
if (updateErr) {
  console.error(`Update failed: ${updateErr.message}`);
  Deno.exit(1);
}

console.log(`\n✓ Key issued for ${existing.client_name} (${engagementId})`);
console.log(`\n  ${apiKey}\n`);
console.log("Copy it into the engagement's sensitive Airtable field NOW — it is");
console.log("not stored and cannot be shown again.\n");
