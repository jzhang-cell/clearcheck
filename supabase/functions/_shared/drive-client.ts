// Google Drive client for edge functions: service-account auth (sign a JWT,
// exchange it for an access token) + Drive list/download helpers.
//
// Ported from scripts/sync-drive-evidence.ts, with two deploy-time changes:
//   1. Reads the service-account key from the GOOGLE_SA_JSON env secret (Vault)
//      instead of a local file — a deployed function has no filesystem.
//   2. Supports optional Domain-Wide Delegation via GOOGLE_DRIVE_SUBJECT: when
//      set, the JWT impersonates that Workspace user (`sub` claim), which is
//      what a members-only Shared Drive requires (see ADR-010).

import { fetchWithRetry } from "./retry.ts";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  // Bytes, when Drive reports it (absent for Google-native docs). Used by the
  // evidence sync to serialize heavyweight files instead of loading several
  // 100+ page reports into one worker's memory at once.
  size?: number;
}

function b64url(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function loadServiceAccount(): ServiceAccount {
  const raw = Deno.env.get("GOOGLE_SA_JSON");
  if (!raw) throw new Error("GOOGLE_SA_JSON env secret is not set");
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(raw) as ServiceAccount;
  } catch (err) {
    throw new Error(`GOOGLE_SA_JSON is not valid JSON: ${(err as Error).message}`);
  }
  if (!sa.client_email || !sa.private_key || !sa.token_uri) {
    throw new Error("GOOGLE_SA_JSON missing client_email/private_key/token_uri");
  }
  return sa;
}

// Sign a JWT with the service-account key and exchange it for an access token.
export async function getDriveAccessToken(): Promise<string> {
  const sa = loadServiceAccount();
  const subject = Deno.env.get("GOOGLE_DRIVE_SUBJECT"); // optional DWD impersonation
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim: Record<string, unknown> = {
    iss: sa.client_email,
    scope: DRIVE_SCOPE,
    aud: sa.token_uri,
    exp: now + 3600,
    iat: now,
  };
  if (subject) claim.sub = subject;

  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${b64url(sig)}`;

  // Token minting is idempotent — a transient failure here would otherwise fail
  // the whole control's evidence sync before a single file moved.
  const res = await fetchWithRetry(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  }, { label: "drive token" });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Drive token exchange failed: ${JSON.stringify(data)}`);
  }
  return data.access_token as string;
}

// List Drive files matching a query. Shared-drive aware.
export async function driveList(token: string, q: string): Promise<DriveFile[]> {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", q);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("corpora", "allDrives");
  url.searchParams.set("pageSize", "1000");
  url.searchParams.set("fields", "files(id,name,mimeType,size)");
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${token}` },
  }, { label: "drive list" });
  const data = await res.json();
  if (data.error) throw new Error(`Drive list failed: ${JSON.stringify(data.error)}`);
  // Drive reports size as a string (and omits it for Google-native docs).
  return ((data.files ?? []) as { id: string; name: string; mimeType: string; size?: string }[])
    .map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size !== undefined ? Number(f.size) : undefined,
    }));
}

// Download a Drive file's bytes by id. Shared-drive aware.
// Per-attempt timeout for a Drive download. Without it a stalled connection hangs
// forever (the fetch has no default timeout), which deadlocks the sync worker and
// freezes the whole control's progress bar. Env-overridable.
const DRIVE_DOWNLOAD_TIMEOUT_MS = Math.max(
  5_000,
  Number(Deno.env.get("DRIVE_DOWNLOAD_TIMEOUT_MS") ?? "25000"),
);

export async function driveDownload(token: string, fileId: string): Promise<Uint8Array> {
  const url =
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  // Two attempts with a real AbortController timeout: a transient stall aborts at
  // DRIVE_DOWNLOAD_TIMEOUT_MS and is retried once (transient stalls usually clear),
  // instead of hanging until the platform kills the whole invocation.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DRIVE_DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Drive download ${fileId}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      const aborted = (e as Error)?.name === "AbortError";
      console.warn(
        `driveDownload ${fileId} attempt ${attempt}/2 failed` +
          `${aborted ? ` (timed out after ${DRIVE_DOWNLOAD_TIMEOUT_MS}ms)` : ""}: ` +
          `${(e as Error)?.message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `Drive download ${fileId} failed after 2 attempts: ${(lastErr as Error)?.message}`,
  );
}
