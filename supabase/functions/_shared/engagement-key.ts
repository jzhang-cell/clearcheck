// Per-engagement API key helpers (ADR-011, half 2).
//
// A key authenticates a caller AND identifies its engagement (the inbound key
// maps to exactly one engagement). We store only the SHA-256 hash; the
// plaintext is shown once by register-engagement and never persisted.
//
// Used by both register-engagement (mint on create) and auth.resolveEngagementByKey
// (verify inbound), so the generate/hash logic lives in one place.

const KEY_PREFIX = "cck"; // ClearCheck — makes a leaked key greppable/identifiable.
const KEY_BYTES = 32; // 256 bits of entropy → safe to SHA-256 without a slow KDF.

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A fresh, high-entropy key, e.g. "cck_3Qy...". Generate once per engagement.
export function generateApiKey(): string {
  const raw = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(raw);
  return `${KEY_PREFIX}_${b64url(raw)}`;
}

// SHA-256 hex of the full key string. Deterministic — minting and verification
// must hash identically. Stored in engagements.api_key_hash.
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
