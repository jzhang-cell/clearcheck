import { parseClaudeJson } from "../_shared/claude-parse.ts";

export const C2C_CHANGE_TYPES = [
  "✅ No difference",
  "🔎 Editorial change",
  "🚨 Substantive change",
] as const;

export type C2CChangeType = (typeof C2C_CHANGE_TYPES)[number];

export interface ClientControl {
  control_id: string;
  control_description: string;
  criteria: string[];
  owner: string;
  source_row: number;
}

export interface ParsedClientControls {
  controls: ClientControl[];
  columns: {
    control_id: string;
    control_description: string;
    criteria: string;
    owner: string;
  };
}

export interface C2CComparisonInput {
  "Control ID": string;
  "Control Description": string;
  "Control Description (Baseline)": string;
}

export interface C2CResult {
  control_id: string;
  change_type: C2CChangeType;
  baseline_change_suggestion: string;
}

const HEADER_ALIASES = {
  control_id: [
    "control id",
    "baseline control id",
    "control identifier",
    "control code",
  ],
  control_description: [
    "control description",
    "client control description",
    "description",
  ],
  criteria: [
    "criteria",
    "tsc criteria",
    "trust services criteria",
    "trust service criteria",
  ],
  owner: ["owner", "control owner", "process owner"],
} as const;

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function findColumn(headers: string[], aliases: readonly string[]): number {
  const normalized = headers.map(normalizeHeader);
  return normalized.findIndex((header) => aliases.includes(header));
}

export function parseCsvMatrix(csvText: string): string[][] {
  const text = csvText.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (inQuotes) throw new Error("Client Control CSV contains an unclosed quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => cell.trim() !== ""));
}

function locateHeader(rows: string[][]): {
  rowIndex: number;
  indices: Record<keyof typeof HEADER_ALIASES, number>;
} {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 25); rowIndex++) {
    const row = rows[rowIndex];
    const indices = {
      control_id: findColumn(row, HEADER_ALIASES.control_id),
      control_description: findColumn(row, HEADER_ALIASES.control_description),
      criteria: findColumn(row, HEADER_ALIASES.criteria),
      owner: findColumn(row, HEADER_ALIASES.owner),
    };
    if (Object.values(indices).every((index) => index >= 0)) return { rowIndex, indices };
  }
  throw new Error(
    "Could not identify Control ID, Control Description, Criteria, and Owner columns " +
      "in the first 25 rows of the Client Control CSV",
  );
}

export function parseCriteria(value: unknown): string[] {
  return [
    ...new Set(
      String(value ?? "")
        .split(/[,;\n]+/)
        .map((criterion) => criterion.trim())
        .filter(Boolean),
    ),
  ];
}

export function parseClientControlCsv(csvText: string): ParsedClientControls {
  const rows = parseCsvMatrix(csvText);
  if (rows.length === 0) throw new Error("Client Control CSV is empty");

  const { rowIndex, indices } = locateHeader(rows);
  const headers = rows[rowIndex];
  const controls: ClientControl[] = [];
  const seen = new Set<string>();

  for (let index = rowIndex + 1; index < rows.length; index++) {
    const row = rows[index];
    const controlId = String(row[indices.control_id] ?? "").trim();
    // The sample format uses blank-ID continuation rows for Expected Evidence.
    // Expected Evidence and Status are intentionally out of scope, so skip them.
    if (!controlId) continue;

    const duplicateKey = controlId.toLowerCase();
    if (seen.has(duplicateKey)) {
      throw new Error(`Duplicate Control ID '${controlId}' in CSV row ${index + 1}`);
    }
    seen.add(duplicateKey);

    const description = String(row[indices.control_description] ?? "").trim();
    if (!description) {
      throw new Error(`Control ${controlId} has an empty Control Description`);
    }

    controls.push({
      control_id: controlId,
      control_description: description,
      criteria: parseCriteria(row[indices.criteria]),
      owner: String(row[indices.owner] ?? "").trim(),
      source_row: index + 1,
    });
  }

  if (controls.length === 0) throw new Error("Client Control CSV contains no control rows");
  return {
    controls,
    columns: {
      control_id: headers[indices.control_id],
      control_description: headers[indices.control_description],
      criteria: headers[indices.criteria],
      owner: headers[indices.owner],
    },
  };
}

export function normalizeRecordKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function linkedRecordIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item) return [item];
    if (
      typeof item === "object" && item !== null &&
      typeof (item as { id?: unknown }).id === "string"
    ) {
      return [(item as { id: string }).id];
    }
    return [];
  });
}

export function airtableCellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) {
    return value.map(airtableCellText).filter(Boolean).join("\n").trim();
  }
  if (typeof value === "object") {
    const candidate = value as { name?: unknown; value?: unknown };
    if (typeof candidate.name === "string") return candidate.name.trim();
    if (typeof candidate.value === "string") return candidate.value.trim();
  }
  return "";
}

export function formatOwnerValue(owner: string, fieldType: string | undefined): unknown {
  if (!owner) return null;
  if (fieldType === "singleSelect") return { name: owner };
  if (fieldType === "multipleSelects") return [{ name: owner }];
  // Text fields accept this directly. With typecast=true Airtable can also make
  // a best-effort conversion for other compatible field types.
  return owner;
}

export function buildAirtableControlFields(args: {
  control: ClientControl;
  baselineRecordId: string;
  tscRecordIds: string[];
  ownerFieldType?: string;
}): Record<string, unknown> {
  return {
    "Control ID": args.control.control_id,
    "Baseline Control ID": [args.baselineRecordId],
    "Control Description": args.control.control_description,
    "TSC Criteria": args.tscRecordIds,
    "Owner": formatOwnerValue(args.control.owner, args.ownerFieldType),
  };
}

function canonicalChangeType(value: unknown): C2CChangeType {
  const normalized = String(value ?? "")
    .replace(/[✅🔎🚨]/gu, "")
    .trim()
    .toLowerCase();
  if (normalized === "no difference") return "✅ No difference";
  if (normalized === "editorial change") return "🔎 Editorial change";
  if (normalized === "substantive change") return "🚨 Substantive change";
  throw new Error(`Unknown C2C change_type '${String(value)}'`);
}

export function parseC2CResults(raw: string): C2CResult[] {
  const { parsed } = parseClaudeJson(raw);
  const rows = parsed.results;
  if (!Array.isArray(rows)) throw new Error("C2C output is missing a results array");

  return rows.map((row, index) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`C2C result ${index + 1} is not an object`);
    }
    const value = row as Record<string, unknown>;
    const controlId = String(value.control_id ?? "").trim();
    const suggestion = String(value.baseline_change_suggestion ?? "").trim();
    if (!controlId) throw new Error(`C2C result ${index + 1} has no control_id`);
    if (!suggestion) {
      throw new Error(`C2C result ${controlId} has no baseline_change_suggestion`);
    }
    return {
      control_id: controlId,
      change_type: canonicalChangeType(value.change_type),
      baseline_change_suggestion: suggestion,
    };
  });
}

export function validateC2CResultSet(results: C2CResult[], expectedIds: string[]): void {
  const expected = new Set(expectedIds.map((id) => normalizeRecordKey(id)));
  const seen = new Set<string>();
  const extras: string[] = [];

  for (const result of results) {
    const key = normalizeRecordKey(result.control_id);
    if (seen.has(key)) {
      throw new Error(`Claude returned duplicate Control ID '${result.control_id}'`);
    }
    seen.add(key);
    if (!expected.has(key)) extras.push(result.control_id);
  }

  const missing = expectedIds.filter((id) => !seen.has(normalizeRecordKey(id)));
  if (missing.length > 0 || extras.length > 0) {
    throw new Error(
      `C2C result IDs did not match the input` +
        `${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}` +
        `${extras.length > 0 ? `; unexpected: ${extras.join(", ")}` : ""}`,
    );
  }
}
