// Shared best-effort Airtable helpers for mirroring Supabase results back into
// Airtable fields. Failures are RETURNED, never thrown — an Airtable write-back
// must never fail the underlying operation (refine/audit/ingest).
//
// Transient failures (429 rate limit, 5xx, network blips) are retried via
// fetchWithRetry before a failure is returned. Airtable caps at 5 req/s per
// base, so a paced engagement run WILL see 429s under load — those should heal
// silently, not surface as missing verdicts. POSTs retry only on 429 (a 5xx may
// have already created the record; retrying could duplicate an Evidence Log row).

import { fetchWithRetry } from "./retry.ts";

export interface AirtablePatchResult {
  attempted: boolean;
  ok: boolean;
  status?: number;
  error?: string;
  skip_reason?: "no_record_id" | "no_base_id" | "no_pat";
  // Airtable rejects an entire PATCH when one field name does not exist. The
  // helper removes unknown fields one at a time and retries the remaining
  // fields, reporting what it omitted so job_runs keeps the schema warning.
  omitted_fields?: string[];
}

export interface AirtableCreateResult {
  attempted: boolean;
  ok: boolean;
  record_id?: string;
  status?: number;
  error?: string;
  skip_reason?: "no_base_id" | "no_pat";
}

export interface AirtableGetResult {
  attempted: boolean;
  ok: boolean;
  record?: AirtableRecord;
  status?: number;
  error?: string;
  skip_reason?: "no_record_id" | "no_base_id" | "no_pat";
}

export function unknownAirtableFieldName(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: { type?: unknown; message?: unknown };
    };
    if (
      parsed.error?.type !== "UNKNOWN_FIELD_NAME" ||
      typeof parsed.error.message !== "string"
    ) {
      return null;
    }
    const match = parsed.error.message.match(/Unknown field name:\s*"([^"]+)"/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function patchAirtableRecord(args: {
  baseId: string | null;
  tableId: string;
  recordId: string | null;
  fields: Record<string, unknown>;
}): Promise<AirtablePatchResult> {
  if (!args.recordId) return { attempted: false, ok: true, skip_reason: "no_record_id" };
  if (!args.baseId) return { attempted: false, ok: true, skip_reason: "no_base_id" };

  const pat = Deno.env.get("AIRTABLE_PAT");
  if (!pat) return { attempted: false, ok: true, skip_reason: "no_pat" };

  // tableId is stable across base clones; table names vary per client.
  const url = `https://api.airtable.com/v0/${args.baseId}/${args.tableId}/${args.recordId}`;
  try {
    const remainingFields = { ...args.fields };
    const omittedFields: string[] = [];

    // Airtable reports one unknown field per 422 response. Retry after removing
    // exactly that field, bounded by the original number of fields so malformed
    // responses can never loop forever.
    for (let attempt = 0; attempt <= Object.keys(args.fields).length; attempt++) {
      // PATCH is idempotent (same fields → same result), so the full transient
      // set (429/5xx/network) is safe to retry.
      const resp = await fetchWithRetry(url, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${pat}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields: remainingFields }),
      }, { label: "airtable PATCH" });
      if (resp.ok) {
        return {
          attempted: true,
          ok: true,
          status: resp.status,
          ...(omittedFields.length > 0 ? { omitted_fields: omittedFields } : {}),
        };
      }

      const body = await resp.text();
      const unknownField = resp.status === 422 ? unknownAirtableFieldName(body) : null;
      if (
        unknownField &&
        Object.prototype.hasOwnProperty.call(remainingFields, unknownField) &&
        Object.keys(remainingFields).length > 1
      ) {
        delete remainingFields[unknownField];
        omittedFields.push(unknownField);
        console.warn(
          `Airtable field '${unknownField}' does not exist; retrying PATCH without it`,
        );
        continue;
      }
      return {
        attempted: true,
        ok: false,
        status: resp.status,
        error: `Airtable PATCH ${resp.status}: ${body.slice(0, 500)}`,
        ...(omittedFields.length > 0 ? { omitted_fields: omittedFields } : {}),
      };
    }
    return {
      attempted: true,
      ok: false,
      error: "Airtable PATCH exhausted unknown-field fallback attempts",
      ...(omittedFields.length > 0 ? { omitted_fields: omittedFields } : {}),
    };
  } catch (err) {
    return { attempted: true, ok: false, error: `Airtable fetch threw: ${(err as Error).message}` };
  }
}

// Best-effort Airtable POST — creates a new record in a table.
export async function createAirtableRecord(args: {
  baseId: string | null;
  tableId: string;
  fields: Record<string, unknown>;
}): Promise<AirtableCreateResult> {
  if (!args.baseId) return { attempted: false, ok: true, skip_reason: "no_base_id" };

  const pat = Deno.env.get("AIRTABLE_PAT");
  if (!pat) return { attempted: false, ok: true, skip_reason: "no_pat" };

  const url = `https://api.airtable.com/v0/${args.baseId}/${args.tableId}`;
  try {
    // 429-only retry: see the header note on duplicate-create risk.
    const resp = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${pat}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields: args.fields }),
    }, { label: "airtable POST", retryStatuses: [429] });
    if (!resp.ok) {
      const body = await resp.text();
      return {
        attempted: true,
        ok: false,
        status: resp.status,
        error: `Airtable POST ${resp.status}: ${body.slice(0, 500)}`,
      };
    }
    const data = await resp.json() as { id: string };
    return { attempted: true, ok: true, status: resp.status, record_id: data.id };
  } catch (err) {
    return { attempted: true, ok: false, error: `Airtable fetch threw: ${(err as Error).message}` };
  }
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

// Read one Airtable record. Airtable's `fields[]` projection belongs to the
// list-records endpoint and is rejected on this single-record endpoint, so this
// helper intentionally requests the complete record.
export async function getAirtableRecord(args: {
  baseId: string | null;
  tableId: string;
  recordId: string | null;
}): Promise<AirtableGetResult> {
  if (!args.recordId) return { attempted: false, ok: true, skip_reason: "no_record_id" };
  if (!args.baseId) return { attempted: false, ok: true, skip_reason: "no_base_id" };

  const pat = Deno.env.get("AIRTABLE_PAT");
  if (!pat) return { attempted: false, ok: true, skip_reason: "no_pat" };

  const url = new URL(
    `https://api.airtable.com/v0/${args.baseId}/${args.tableId}/${args.recordId}`,
  );

  try {
    const resp = await fetchWithRetry(url, {
      headers: { "Authorization": `Bearer ${pat}` },
    }, { label: "airtable GET record" });
    if (!resp.ok) {
      const body = await resp.text();
      return {
        attempted: true,
        ok: false,
        status: resp.status,
        error: `Airtable GET ${resp.status}: ${body.slice(0, 500)}`,
      };
    }
    const record = await resp.json() as AirtableRecord;
    return { attempted: true, ok: true, status: resp.status, record };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      error: `Airtable fetch threw: ${(err as Error).message}`,
    };
  }
}

export interface AirtableListResult {
  attempted: boolean;
  ok: boolean;
  records: AirtableRecord[];
  status?: number;
  error?: string;
  skip_reason?: "no_base_id" | "no_pat";
}

// List records from a table, following pagination. Unlike patch/create this is
// used by the pace-controls coordinator to read the control set, so a failure is
// meaningful — it's RETURNED (ok:false) and the caller decides, but the records
// array is always present (empty on failure) so callers can iterate safely.
// `fields` restricts the columns returned (smaller, faster payloads).
export async function listAirtableRecords(args: {
  baseId: string | null;
  tableId: string;
  fields?: string[];
  pageSize?: number;
}): Promise<AirtableListResult> {
  if (!args.baseId) return { attempted: false, ok: true, records: [], skip_reason: "no_base_id" };

  const pat = Deno.env.get("AIRTABLE_PAT");
  if (!pat) return { attempted: false, ok: true, records: [], skip_reason: "no_pat" };

  const records: AirtableRecord[] = [];
  let offset: string | undefined;
  try {
    do {
      const url = new URL(`https://api.airtable.com/v0/${args.baseId}/${args.tableId}`);
      url.searchParams.set("pageSize", String(args.pageSize ?? 100));
      for (const f of args.fields ?? []) url.searchParams.append("fields[]", f);
      if (offset) url.searchParams.set("offset", offset);

      const resp = await fetchWithRetry(url, {
        headers: { "Authorization": `Bearer ${pat}` },
      }, { label: "airtable GET" });
      if (!resp.ok) {
        const body = await resp.text();
        return {
          attempted: true,
          ok: false,
          records,
          status: resp.status,
          error: `Airtable GET ${resp.status}: ${body.slice(0, 500)}`,
        };
      }
      const data = await resp.json() as { records: AirtableRecord[]; offset?: string };
      records.push(...data.records);
      offset = data.offset;
    } while (offset);
    return { attempted: true, ok: true, records };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      records,
      error: `Airtable fetch threw: ${(err as Error).message}`,
    };
  }
}
