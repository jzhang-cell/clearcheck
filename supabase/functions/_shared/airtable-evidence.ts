import { mimeTypeFor } from "./file-type.ts";

export interface AirtableEvidenceAttachment {
  id: string | null;
  url: string;
  filename: string;
  mimeType: string;
  size?: number;
}

// Airtable attachment fields are untyped JSON at the API boundary. Keep only
// usable HTTP(S) attachments and normalize the metadata needed by evidence
// sync. A non-empty field that normalizes to zero attachments is treated as a
// configuration/data error by the caller instead of silently switching sources.
export function parseAirtableEvidenceAttachments(
  value: unknown,
): AirtableEvidenceAttachment[] {
  if (!Array.isArray(value)) return [];

  const attachments: AirtableEvidenceAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
    const filename = typeof candidate.filename === "string" ? candidate.filename.trim() : "";
    if (!url || !filename) continue;

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
    } catch {
      continue;
    }

    const rawSize = typeof candidate.size === "number"
      ? candidate.size
      : typeof candidate.size === "string"
      ? Number(candidate.size)
      : undefined;
    const size = rawSize !== undefined && Number.isFinite(rawSize) && rawSize >= 0
      ? rawSize
      : undefined;
    const suppliedMime = typeof candidate.type === "string" ? candidate.type.trim() : "";

    attachments.push({
      id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : null,
      url,
      filename,
      mimeType: suppliedMime || mimeTypeFor(filename),
      ...(size !== undefined ? { size } : {}),
    });
  }
  return attachments;
}
