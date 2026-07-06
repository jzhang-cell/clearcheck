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
}

export interface AirtableCreateResult {
  attempted: boolean;
  ok: boolean;
  record_id?: string;
  status?: number;
  error?: string;
  skip_reason?: "no_base_id" | "no_pat";
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
    // PATCH is idempotent (same fields → same result), so the full transient
    // set (429/5xx/network) is safe to retry.
    const resp = await fetchWithRetry(url, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${pat}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields: args.fields }),
    }, { label: "airtable PATCH" });
    if (!resp.ok) {
      const body = await resp.text();
      return {
        attempted: true,
        ok: false,
        status: resp.status,
        error: `Airtable PATCH ${resp.status}: ${body.slice(0, 500)}`,
      };
    }
    return { attempted: true, ok: true, status: resp.status };
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
