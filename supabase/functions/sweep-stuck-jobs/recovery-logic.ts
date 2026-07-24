// Pure helpers for the Airtable-triggered bad-control recovery flow.
// Kept separate from index.ts so identifier parsing/matching is unit-testable
// without HTTP, Supabase, or Airtable.

export interface RecoverableControl {
  id: string;
  control_id: string;
  airtable_record_id: string | null;
  engagement_id: string;
}

export interface MatchedControls {
  controls: RecoverableControl[];
  unmatched: string[];
}

function identifierFromValue(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    const normalized = String(value).trim();
    return normalized || null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["id", "control_uuid", "control_id", "airtable_record_id", "name"]) {
      const candidate = identifierFromValue(record[key]);
      if (candidate) return candidate;
    }
  }
  return null;
}

// Airtable inputs can arrive as linked-record objects, lookup arrays, JSON-array
// strings, or rollup strings. Normalize all of those to a de-duplicated list.
export function normalizeBadControlIds(raw: unknown): string[] {
  let values: unknown[];
  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        values = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        values = trimmed.split(/[,;\n]+/);
      }
    } else {
      values = trimmed.split(/[,;\n]+/);
    }
  } else if (raw === null || raw === undefined) {
    return [];
  } else {
    values = [raw];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const id = identifierFromValue(value);
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(id);
  }
  return normalized;
}

// Match each supplied identifier against any of the three identifiers an
// Airtable automation is likely to have: Supabase UUID, display control code,
// or Airtable record id. Preserve the caller's order and never launch a control
// twice when aliases for the same row were supplied.
export function matchBadControls(
  identifiers: string[],
  available: RecoverableControl[],
): MatchedControls {
  const byIdentifier = new Map<string, RecoverableControl>();
  for (const control of available) {
    for (const value of [control.id, control.control_id, control.airtable_record_id]) {
      if (value) byIdentifier.set(value.toLowerCase(), control);
    }
  }

  const controls: RecoverableControl[] = [];
  const unmatched: string[] = [];
  const matchedIds = new Set<string>();
  for (const identifier of identifiers) {
    const control = byIdentifier.get(identifier.toLowerCase());
    if (!control) {
      unmatched.push(identifier);
      continue;
    }
    if (matchedIds.has(control.id)) continue;
    matchedIds.add(control.id);
    controls.push(control);
  }
  return { controls, unmatched };
}

// job_runs producers are not fully uniform: most store `control_uuid`, while
// per-file ingest rows store the same UUID in `control_id`. Match both so an
// explicit bad-control recovery clears every stale child job for that control.
export function jobPayloadMatchesControls(
  payload: Record<string, unknown> | null,
  controls: RecoverableControl[],
): boolean {
  if (!payload) return false;
  const selected = new Set<string>();
  for (const control of controls) {
    selected.add(control.id.toLowerCase());
    selected.add(control.control_id.toLowerCase());
    if (control.airtable_record_id) selected.add(control.airtable_record_id.toLowerCase());
  }
  for (const key of ["control_uuid", "control_id", "airtable_record_id"]) {
    const value = payload[key];
    if (typeof value === "string" && selected.has(value.toLowerCase())) return true;
  }
  return false;
}

export function sweepingStatus(jobCount: number): string {
  return `🧹 Sweeping the total ${jobCount} ${jobCount === 1 ? "job" : "jobs"}.`;
}
